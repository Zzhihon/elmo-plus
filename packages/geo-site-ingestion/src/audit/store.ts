import { randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import {
	GEO_QUEUE,
	GeoError,
	type GeoFindingSeverity,
	type GeoPrincipal,
	type GeoSiteAuditRunStatus,
	type GeoTaskKind,
	geoSystemPrincipal,
} from "@workspace/geo-domain";
import { normalizeUrl } from "@workspace/geo-evidence";
import type { DbConnection } from "@workspace/lib/db/db-connection";
import {
	geoOptimizationTasks,
	geoPrompts,
	geoSiteAuditFindings,
	geoSiteAuditRuns,
	geoSiteCrawlItems,
	geoSitePages,
	geoSitePageVersions,
} from "@workspace/lib/db/schema";
import { raiseGeoAlert } from "@workspace/lib/geo/alerts";
import { writeGeoAudit } from "@workspace/lib/geo/audit";
import * as cheerio from "cheerio";
import { and, desc, eq, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import {
	CRAWLER_PRODUCT_TOKEN,
	classifyStatus,
	isRetryableFailure,
	LIMITS,
	minIntervalMs,
	SITEMAP_MIME_TYPES,
	userAgentOf,
} from "../crawl-policy";
import { siteDiscovery } from "../discovery";
import { decodeHtml } from "../net/charset";
import { isAllowedByRobots, parseRobots } from "../net/robots";
import { parseContentType, type SafeFetchOptions, type SafeFetchResult, safeFetch } from "../net/safe-fetch";
import { isAllowedHost } from "../net/url-policy";
import { parseOpWindow, type SiteProfile } from "../profile";
import { isWithinWindow } from "../schedule";
import { nowOf, type SendJob, type SiteJobDeps } from "../store/deps";
import { loadParsedPage } from "../store/parse";
import { loadSiteSource, profileOfSource, type SiteSourceRow } from "../store/sources";
import { acquireHostSlot } from "../store/throttle";
import { findingPriorityOf, SITE_AUDIT_ENGINE_VERSION, siteAuditRule } from "./catalog";
import { resolveAuditConfig } from "./config";
import { type AuditPageFacts, extractAuditFacts } from "./facts";
import { type PromptCandidate, recommendTargetPrompts } from "./recommend";
import { type ExistingFinding, type ReconcileAction, reconcileFindings, subjectKeyOf } from "./reconcile";
import { type AuditDetection, evaluatePageRules, type KnownPage } from "./rules";
import {
	classifyHttpsProbe,
	classifyRobotsProbe,
	evaluateSiteChecks,
	type HttpsProbe,
	type RobotsProbe,
	type SitemapFileProbe,
	type SitemapProbe,
	type SiteProbes,
} from "./site-checks";

export type SiteAuditRunRow = typeof geoSiteAuditRuns.$inferSelect;
export type SiteAuditFindingRow = typeof geoSiteAuditFindings.$inferSelect;

export const ACTIVE_AUDIT_STATUSES: GeoSiteAuditRunStatus[] = ["QUEUED", "RUNNING"];

/** A crawl's parse jobs get this long to finish before its audit runs on whatever has been parsed. */
const PARSE_WAIT_MS = 45 * 60_000;
const PARSE_RECHECK_MS = 2 * 60_000;
const RUNNING_STALE_MS = 40 * 60_000;
const QUEUED_STALE_MS = 20 * 60_000;
const MAX_FACT_TEXT = 50_000;
const MAX_SITEMAP_FILES = 4;
const HTTPS_PROBE_BYTES = 512 * 1024;
const MAX_RUNS_PER_SOURCE_PER_DAY = 24;

export type SitemapFileSummary = Omit<SitemapFileProbe, "pages" | "nested"> & { pages: number; nested: number };

/** What the site-wide probes saw, kept on the run that made them. */
export interface SiteProbeSummary {
	checkedAt: string;
	robots: Exclude<RobotsProbe, { kind: "FILE" }> | { kind: "FILE"; url: string; status: number };
	sitemap: { kind: "SKIPPED"; reason: string } | { kind: "CHECKED"; files: SitemapFileSummary[] };
	https: HttpsProbe;
}

export interface SiteAuditRunCounts {
	pages: number;
	skippedPages: number;
	detections: number;
	inserted: number;
	refreshed: number;
	reopened: number;
	resolved: number;
	open: Partial<Record<GeoFindingSeverity, number>>;
	pendingParse: number;
	site?: SiteProbeSummary;
}

// ---------------------------------------------------------------------------
// Creating and queueing runs
// ---------------------------------------------------------------------------

export interface CreateSiteAuditRunInput {
	siteSourceId: string;
	idempotencyKey?: string | null;
	crawlRunId?: string | null;
	/** Probe robots.txt, the sitemap and HTTPS; off for audits after a crawl of a few chosen URLs. */
	siteChecks?: boolean;
}

async function runByKey(tx: DbConnection, organizationId: string, idempotencyKey: string) {
	const [row] = await tx
		.select()
		.from(geoSiteAuditRuns)
		.where(
			and(eq(geoSiteAuditRuns.organizationId, organizationId), eq(geoSiteAuditRuns.idempotencyKey, idempotencyKey)),
		)
		.limit(1);
	return row ?? null;
}

async function activeRunOf(tx: DbConnection, organizationId: string, siteSourceId: string) {
	const [active] = await tx
		.select()
		.from(geoSiteAuditRuns)
		.where(
			and(
				eq(geoSiteAuditRuns.organizationId, organizationId),
				eq(geoSiteAuditRuns.siteSourceId, siteSourceId),
				inArray(geoSiteAuditRuns.status, ACTIVE_AUDIT_STATUSES),
			),
		)
		.limit(1);
	return active ?? null;
}

async function assertDailyLimit(tx: DbConnection, siteSourceId: string): Promise<void> {
	const [{ value: today }] = await tx
		.select({ value: sql<number>`count(*)::int` })
		.from(geoSiteAuditRuns)
		.where(
			and(
				eq(geoSiteAuditRuns.siteSourceId, siteSourceId),
				sql`${geoSiteAuditRuns.createdAt} > now() - interval '24 hours'`,
			),
		);
	if (today >= MAX_RUNS_PER_SOURCE_PER_DAY) {
		throw new GeoError("RATE_LIMITED", `同一站点 24 小时内最多审计 ${MAX_RUNS_PER_SOURCE_PER_DAY} 次`);
	}
}

/**
 * Records an audit run for a site. A run already queued or running for the same
 * site is returned instead of a second one, and so is a repeat of the same key.
 */
export async function createSiteAuditRun(
	tx: DbConnection,
	principal: GeoPrincipal,
	input: CreateSiteAuditRunInput,
): Promise<{ run: SiteAuditRunRow; created: boolean }> {
	const { organizationId } = principal;
	await loadSiteSource(tx, organizationId, input.siteSourceId);
	if (input.idempotencyKey) {
		const existing = await runByKey(tx, organizationId, input.idempotencyKey);
		if (existing) return { run: existing, created: false };
	}
	const active = await activeRunOf(tx, organizationId, input.siteSourceId);
	if (active) return { run: active, created: false };
	if (principal.actorKind !== "system") await assertDailyLimit(tx, input.siteSourceId);

	const [run] = await tx
		.insert(geoSiteAuditRuns)
		.values({
			organizationId,
			siteSourceId: input.siteSourceId,
			status: "QUEUED",
			ruleVersion: SITE_AUDIT_ENGINE_VERSION,
			idempotencyKey: input.idempotencyKey ?? `manual:${randomUUID()}`,
			requestedBy: principal.actorId,
			crawlRunId: input.crawlRunId ?? null,
			siteChecks: input.siteChecks ?? true,
		})
		.onConflictDoNothing()
		.returning();
	if (!run) {
		const raced = input.idempotencyKey ? await runByKey(tx, organizationId, input.idempotencyKey) : null;
		if (!raced) throw new GeoError("CONFLICT", "审计任务正在创建，请稍后重试");
		return { run: raced, created: false };
	}
	await writeGeoAudit(tx, {
		principal,
		action: "site_audit.run.create",
		entityType: "site_audit_run",
		entityId: run.id,
		after: run,
		metadata: { siteSourceId: input.siteSourceId, crawlRunId: input.crawlRunId ?? null, siteChecks: run.siteChecks },
	});
	return { run, created: true };
}

export function enqueueSiteAuditRun(
	send: SendJob,
	run: Pick<SiteAuditRunRow, "id" | "organizationId">,
	options: { startAfter?: Date | number; tag?: string } = {},
): Promise<string | null> {
	return send(
		GEO_QUEUE.siteAudit,
		{ organizationId: run.organizationId, runId: run.id },
		{ singletonKey: `audit:${run.id}${options.tag ? `:${options.tag}` : ""}`, startAfter: options.startAfter },
	);
}

/**
 * Called when a crawl finishes without failing. Parsing continues on its own
 * queue after the crawl, so the audit starts a little later and waits for it.
 */
export async function enqueueSiteAuditAfterCrawl(
	deps: Pick<SiteJobDeps, "db" | "send">,
	crawl: { id: string; organizationId: string; siteSourceId: string; fullScope: boolean },
): Promise<string | null> {
	const principal = geoSystemPrincipal(crawl.organizationId, "site-audit", `crawl-${crawl.id}`);
	const { run, created } = await deps.db.transaction((tx) =>
		createSiteAuditRun(tx, principal, {
			siteSourceId: crawl.siteSourceId,
			idempotencyKey: `crawl:${crawl.id}`,
			crawlRunId: crawl.id,
			siteChecks: crawl.fullScope,
		}),
	);
	if (!created && run.crawlRunId !== crawl.id) return null;
	return enqueueSiteAuditRun(deps.send, run, { startAfter: 60 });
}

// ---------------------------------------------------------------------------
// Polite network access for the site-wide checks
// ---------------------------------------------------------------------------

interface ProbeContext {
	deps: SiteJobDeps;
	source: SiteSourceRow;
	organizationId: string;
	interval: number;
	userAgent: string;
	fetch: (url: string, options: SafeFetchOptions) => Promise<SafeFetchResult>;
	/** Set once the host refuses us a slot; every later probe is skipped rather than queued behind it. */
	stopped: string | null;
}

/**
 * The crawler's own discipline for every request the audit makes: the shared
 * per-host slot and interval, the guarded fetch, and the circuit breaker fed.
 * No retries: a probe that fails is a finding, not something to hammer.
 */
async function probeFetch(
	ctx: ProbeContext,
	url: string,
	options: Pick<SafeFetchOptions, "maxBytes" | "timeoutMs" | "allowedMimeTypes" | "accept">,
): Promise<SafeFetchResult | null> {
	if (ctx.stopped) return null;
	const host = new URL(url).hostname;
	const slot = await acquireHostSlot(ctx.deps, host, ctx.interval);
	if (!slot.ok) {
		ctx.stopped = slot.reason === "CIRCUIT_OPEN" ? "该域名已熔断，暂停请求" : "该域名正被其他任务占用";
		return null;
	}
	let result: SafeFetchResult;
	try {
		result = await ctx.fetch(url, { ...options, allowedHosts: ctx.source.allowedHosts, userAgent: ctx.userAgent });
	} catch (error) {
		await slot.release(false);
		throw error;
	}
	const retryable = result.ok ? classifyStatus(result.status).kind === "RETRYABLE" : isRetryableFailure(result.code);
	const health = await slot.release(!retryable);
	if (health.tripped) {
		await raiseGeoAlert(ctx.deps.db, {
			organizationId: ctx.organizationId,
			kind: "site.circuit_open",
			severity: "CRITICAL",
			dedupeKey: `site-circuit-open:${host}`,
			context: { host, siteSourceId: ctx.source.id, until: health.breakerOpenUntil, from: "site-audit" },
		});
	}
	return result;
}

async function probeRobots(ctx: ProbeContext): Promise<RobotsProbe> {
	const url = new URL("/robots.txt", ctx.source.baseUrl).toString();
	const result = await probeFetch(ctx, url, {
		maxBytes: LIMITS.robotsBytes,
		timeoutMs: LIMITS.fetchTimeoutMs,
		allowedMimeTypes: ["text/plain"],
		accept: "text/plain",
	});
	if (!result) return { kind: "SKIPPED", reason: ctx.stopped ?? "未请求" };
	const text = result.ok ? decodeHtml(result.body, result.charset).text : null;
	return classifyRobotsProbe(url, result, text);
}

function sitemapText(result: Extract<SafeFetchResult, { ok: true }>): string {
	if (result.mimeType === "application/gzip" || result.mimeType === "application/x-gzip") {
		return gunzipSync(result.body, { maxOutputLength: LIMITS.sitemapBytes }).toString("utf8");
	}
	return decodeHtml(result.body, result.charset).text;
}

async function probeSitemapFile(ctx: ProbeContext, url: string, declared: boolean): Promise<SitemapFileProbe | null> {
	const result = await probeFetch(ctx, url, {
		maxBytes: LIMITS.sitemapBytes,
		timeoutMs: LIMITS.fetchTimeoutMs,
		allowedMimeTypes: [...SITEMAP_MIME_TYPES, "application/gzip", "application/x-gzip"],
		accept: "application/xml,text/xml;q=0.9,*/*;q=0.1",
	});
	if (!result) return null;
	const base = { url, declared, pages: [] as string[], nested: [] as string[] };
	if (!result.ok) {
		const error = result.code === "MIME_REJECTED" ? "返回的不是 XML（可能是网页形式的 404）" : result.detail;
		return { ...base, status: result.status ?? null, error, valid: false };
	}
	if (result.status < 200 || result.status >= 300) {
		return { ...base, status: result.status, error: `HTTP ${result.status}`, valid: false };
	}
	try {
		const xml = sitemapText(result);
		const $ = cheerio.load(xml, { xml: true });
		if ($("urlset").length === 0 && $("sitemapindex").length === 0) {
			return { ...base, status: result.status, error: "根元素不是 urlset 或 sitemapindex", valid: false };
		}
		const found = siteDiscovery.sitemapUrls(xml, url);
		return { ...base, status: result.status, error: null, valid: true, pages: found.pages, nested: found.sitemaps };
	} catch (error) {
		return { ...base, status: result.status, error: `无法解析：${(error as Error).message}`, valid: false };
	}
}

async function probeSitemaps(ctx: ProbeContext, declared: string[]): Promise<SitemapProbe> {
	const allowed = (url: string) => isAllowedHost(new URL(url).hostname, ctx.source.allowedHosts);
	const fallback = new URL("/sitemap.xml", ctx.source.baseUrl).toString();
	const queue: Array<{ url: string; declared: boolean }> = [
		...declared.filter(allowed).map((url) => ({ url, declared: true })),
		...(declared.includes(fallback) ? [] : [{ url: fallback, declared: false }]),
	];
	const files: SitemapFileProbe[] = [];
	const visited = new Set<string>();
	while (queue.length > 0 && files.length < MAX_SITEMAP_FILES) {
		const next = queue.shift() as { url: string; declared: boolean };
		if (visited.has(next.url)) continue;
		visited.add(next.url);
		const file = await probeSitemapFile(ctx, next.url, next.declared);
		if (!file) return { kind: "SKIPPED", reason: ctx.stopped ?? "未请求" };
		files.push(file);
		for (const nested of file.nested.filter(allowed)) queue.push({ url: nested, declared: false });
	}
	return { kind: "CHECKED", files };
}

async function probeHttps(ctx: ProbeContext, robotsText: string | null): Promise<HttpsProbe> {
	const host = new URL(ctx.source.baseUrl).hostname;
	const policy = robotsText ? parseRobots(robotsText, CRAWLER_PRODUCT_TOKEN) : null;
	const homeAllowed = !policy || isAllowedByRobots(policy, "/");
	const url = `https://${host}${homeAllowed ? "/" : "/robots.txt"}`;
	const result = await probeFetch(ctx, url, {
		maxBytes: HTTPS_PROBE_BYTES,
		timeoutMs: LIMITS.fetchTimeoutMs,
		allowedMimeTypes: [],
		accept: homeAllowed ? undefined : "text/plain",
	});
	if (!result) return { kind: "SKIPPED", reason: ctx.stopped ?? "未请求" };
	const probe = classifyHttpsProbe(url, result);
	if (!homeAllowed && probe.kind === "ERROR_STATUS" && probe.status < 500) {
		return { kind: "OK", url, finalUrl: url, status: probe.status };
	}
	return probe;
}

async function runSiteProbes(deps: SiteJobDeps, source: SiteSourceRow, organizationId: string): Promise<SiteProbes> {
	const ctx: ProbeContext = {
		deps,
		source,
		organizationId,
		interval: minIntervalMs(source.requestsPerSecond, null),
		userAgent: userAgentOf(source.userAgentContact),
		fetch: deps.fetch ?? safeFetch,
		stopped: null,
	};
	const robots = await probeRobots(ctx);
	if (robots.kind === "UNAVAILABLE") {
		const reason = "robots.txt 无法获取，按 RFC 9309 不再请求本站其他网址";
		return {
			baseUrl: source.baseUrl,
			robots,
			sitemap: { kind: "SKIPPED", reason },
			https: { kind: "SKIPPED", reason },
		};
	}
	const robotsText = robots.kind === "FILE" ? robots.text : null;
	if (robotsText) {
		const delay = parseRobots(robotsText, CRAWLER_PRODUCT_TOKEN).crawlDelaySeconds;
		ctx.interval = minIntervalMs(source.requestsPerSecond, delay);
	}
	const declared = robotsText ? parseRobots(robotsText, CRAWLER_PRODUCT_TOKEN).sitemaps : [];
	const sitemap = await probeSitemaps(
		ctx,
		declared.map((url) => normalizeUrl(url) ?? url).filter((url) => /^https?:/i.test(url)),
	);
	const https = await probeHttps(ctx, robotsText);
	return { baseUrl: source.baseUrl, robots, sitemap, https };
}

/** A paused source or one outside its operating window gets no requests; the run says why. */
async function siteProbesFor(deps: SiteJobDeps, source: SiteSourceRow, organizationId: string): Promise<SiteProbes> {
	const window = parseOpWindow(source.opWindow);
	const reason = !source.enabled
		? "站点已暂停采集，本次不请求源站"
		: window && !isWithinWindow(window, nowOf(deps))
			? "当前不在站点允许的运营时窗内，本次不请求源站"
			: null;
	if (!reason) return runSiteProbes(deps, source, organizationId);
	const skipped = { kind: "SKIPPED" as const, reason };
	return { baseUrl: source.baseUrl, robots: skipped, sitemap: skipped, https: skipped };
}

/** The probe results with page lists and robots text cut out, small enough to keep on the run. */
function probeSummary(probes: SiteProbes, now: Date): SiteProbeSummary {
	const { robots } = probes;
	return {
		checkedAt: now.toISOString(),
		robots: robots.kind === "FILE" ? { kind: "FILE", url: robots.url, status: robots.status } : robots,
		sitemap:
			probes.sitemap.kind === "CHECKED"
				? {
						kind: "CHECKED",
						files: probes.sitemap.files.map((file) => ({
							...file,
							pages: file.pages.length,
							nested: file.nested.length,
						})),
					}
				: probes.sitemap,
		https: probes.https,
	};
}

// ---------------------------------------------------------------------------
// Reading the stored evidence
// ---------------------------------------------------------------------------

type PageRow = Pick<
	typeof geoSitePages.$inferSelect,
	"id" | "normalizedUrl" | "status" | "httpStatus" | "canonicalUrl" | "category"
>;

async function loadPages(db: DbConnection, organizationId: string, sourceId: string): Promise<PageRow[]> {
	return db
		.select({
			id: geoSitePages.id,
			normalizedUrl: geoSitePages.normalizedUrl,
			status: geoSitePages.status,
			httpStatus: geoSitePages.httpStatus,
			canonicalUrl: geoSitePages.canonicalUrl,
			category: geoSitePages.category,
		})
		.from(geoSitePages)
		.where(and(eq(geoSitePages.organizationId, organizationId), eq(geoSitePages.siteSourceId, sourceId)));
}

async function latestVersions(db: DbConnection, organizationId: string, pageIds: string[]) {
	if (pageIds.length === 0) return new Map<string, typeof geoSitePageVersions.$inferSelect>();
	const rows = await db
		.selectDistinctOn([geoSitePageVersions.pageId])
		.from(geoSitePageVersions)
		.where(
			and(
				eq(geoSitePageVersions.organizationId, organizationId),
				inArray(geoSitePageVersions.pageId, pageIds),
				ne(geoSitePageVersions.parseStatus, "SKIPPED"),
			),
		)
		.orderBy(geoSitePageVersions.pageId, desc(geoSitePageVersions.fetchedAt), desc(geoSitePageVersions.createdAt));
	return new Map(rows.map((row) => [row.pageId, row]));
}

function isHomeUrl(url: string, baseUrl: string): boolean {
	const home = normalizeUrl(baseUrl);
	const parsed = new URL(url);
	return (
		url === home ||
		((parsed.pathname === "/" || /^\/index\.(html?|php|aspx?)$/i.test(parsed.pathname)) && !parsed.search)
	);
}

async function collectFacts(
	deps: SiteJobDeps,
	source: SiteSourceRow,
	profile: SiteProfile,
	pages: PageRow[],
): Promise<{ facts: AuditPageFacts[]; skipped: number }> {
	const active = pages.filter((page) => page.status === "ACTIVE");
	const versions = await latestVersions(
		deps.db,
		source.organizationId,
		active.map((page) => page.id),
	);
	const keySections = new Set(
		profile.categories.filter((category) => category.keySection).map((category) => category.key),
	);
	const facts: AuditPageFacts[] = [];
	let skipped = 0;
	for (const page of active) {
		const version = versions.get(page.id);
		const raw = version ? await deps.objectStore.get(version.htmlObjectKey) : null;
		if (!version || !raw) {
			skipped += version ? 1 : 0;
			continue;
		}
		const html = decodeHtml(raw.body, parseContentType(raw.contentType ?? undefined).charset).text;
		const parsed = await loadParsedPage(deps, version);
		const pageFacts = extractAuditFacts({
			pageId: page.id,
			versionId: version.id,
			url: page.normalizedUrl,
			html,
			parsed,
			allowedHosts: source.allowedHosts,
			isHome: isHomeUrl(page.normalizedUrl, source.baseUrl),
			keySection: Boolean(parsed?.category && keySections.has(parsed.category)),
		});
		pageFacts.text = pageFacts.text.slice(0, MAX_FACT_TEXT);
		facts.push(pageFacts);
	}
	return { facts, skipped };
}

// ---------------------------------------------------------------------------
// Writing findings
// ---------------------------------------------------------------------------

async function existingFindings(db: DbConnection, sourceId: string): Promise<ExistingFinding[]> {
	const rows = await db
		.select({
			id: geoSiteAuditFindings.id,
			ruleId: geoSiteAuditFindings.ruleId,
			pageId: geoSiteAuditFindings.pageId,
			status: geoSiteAuditFindings.status,
			taskState: geoOptimizationTasks.state,
		})
		.from(geoSiteAuditFindings)
		.leftJoin(geoOptimizationTasks, eq(geoOptimizationTasks.id, geoSiteAuditFindings.taskId))
		.where(eq(geoSiteAuditFindings.siteSourceId, sourceId));
	return rows.map((row) => ({
		id: row.id,
		ruleId: row.ruleId,
		pageId: row.pageId,
		status: row.status,
		taskOpen: row.taskState !== null && row.taskState !== "VERIFIED" && row.taskState !== "CANCELLED",
	}));
}

async function promptCandidates(db: DbConnection, organizationId: string): Promise<PromptCandidate[]> {
	return db
		.select({
			id: geoPrompts.id,
			question: geoPrompts.question,
			productLine: geoPrompts.productLine,
			status: geoPrompts.status,
		})
		.from(geoPrompts)
		.where(and(eq(geoPrompts.organizationId, organizationId), ne(geoPrompts.status, "REJECTED")));
}

interface WriteContext {
	run: SiteAuditRunRow;
	factsByPage: Map<string, AuditPageFacts>;
	prompts: PromptCandidate[];
}

function evidenceOf(detection: AuditDetection, facts: AuditPageFacts | undefined, taskKind: GeoTaskKind) {
	return {
		...detection.evidence,
		url: facts?.url ?? null,
		title: facts?.htmlTitle ?? null,
		category: facts?.categoryLabel ?? null,
		taskKind,
	};
}

function insertValues(ctx: WriteContext, detection: AuditDetection) {
	const rule = siteAuditRule(detection.ruleId);
	if (!rule) throw new Error(`未知的审计规则 ${detection.ruleId}`);
	const facts = detection.pageId ? ctx.factsByPage.get(detection.pageId) : undefined;
	const prominent = !facts || facts.isHome || facts.keySection || facts.entityKind === "PRODUCT";
	const taskKind = detection.taskKind ?? rule.taskKind;
	return {
		organizationId: ctx.run.organizationId,
		runId: ctx.run.id,
		siteSourceId: ctx.run.siteSourceId,
		pageId: detection.pageId,
		subjectKey: subjectKeyOf(detection.pageId),
		ruleId: rule.id,
		ruleVersion: rule.version,
		severity: rule.severity,
		priority: findingPriorityOf(rule.severity, prominent),
		status: "OPEN" as const,
		pageVersionId: detection.versionId,
		evidence: evidenceOf(detection, facts, taskKind),
		recommendation: rule.recommendation,
		ownerDepartment: rule.department,
		targetPromptIds: facts
			? recommendTargetPrompts(
					{
						title: facts.htmlTitle,
						categoryLabel: facts.categoryLabel,
						terms: facts.fields.map((field) => field.value).slice(0, 10),
					},
					ctx.prompts,
				)
			: [],
		lastRunId: ctx.run.id,
	};
}

async function applyActions(tx: DbConnection, ctx: WriteContext, actions: ReconcileAction[]) {
	const inserts = actions.flatMap((action) => (action.kind === "INSERT" ? [insertValues(ctx, action.detection)] : []));
	for (let index = 0; index < inserts.length; index += 200) {
		await tx
			.insert(geoSiteAuditFindings)
			.values(inserts.slice(index, index + 200))
			.onConflictDoNothing({
				target: [geoSiteAuditFindings.siteSourceId, geoSiteAuditFindings.ruleId, geoSiteAuditFindings.subjectKey],
			});
	}
	for (const action of actions) {
		if (action.kind === "REFRESH") {
			const rule = siteAuditRule(action.detection.ruleId);
			const facts = action.detection.pageId ? ctx.factsByPage.get(action.detection.pageId) : undefined;
			await tx
				.update(geoSiteAuditFindings)
				.set({
					status: action.status,
					severity: rule?.severity,
					ruleVersion: rule?.version,
					pageVersionId: action.detection.versionId,
					evidence: evidenceOf(action.detection, facts, action.detection.taskKind ?? rule?.taskKind ?? "SITE_REVISION"),
					lastRunId: ctx.run.id,
					lastSeenAt: sql`now()`,
					...(action.reopened ? { resolvedAt: null, resolvedRunId: null, statusNote: "复跑审计时再次发现" } : {}),
				})
				.where(eq(geoSiteAuditFindings.id, action.findingId));
		} else if (action.kind === "RESOLVE") {
			await tx
				.update(geoSiteAuditFindings)
				.set({
					status: "RESOLVED",
					resolvedAt: sql`now()`,
					resolvedRunId: ctx.run.id,
					statusNote: action.note,
					lastRunId: ctx.run.id,
				})
				.where(
					and(eq(geoSiteAuditFindings.id, action.findingId), inArray(geoSiteAuditFindings.status, ["OPEN", "TASKED"])),
				);
		}
	}
}

async function openCounts(db: DbConnection, sourceId: string) {
	const rows = await db
		.select({ severity: geoSiteAuditFindings.severity, value: sql<number>`count(*)::int` })
		.from(geoSiteAuditFindings)
		.where(
			and(eq(geoSiteAuditFindings.siteSourceId, sourceId), inArray(geoSiteAuditFindings.status, ["OPEN", "TASKED"])),
		)
		.groupBy(geoSiteAuditFindings.severity);
	return Object.fromEntries(rows.map((row) => [row.severity, row.value])) as SiteAuditRunCounts["open"];
}

// ---------------------------------------------------------------------------
// The job
// ---------------------------------------------------------------------------

async function pendingParseCount(db: DbConnection, crawlRunId: string): Promise<number> {
	const [row] = await db
		.select({ value: sql<number>`count(*)::int` })
		.from(geoSiteCrawlItems)
		.where(
			and(
				eq(geoSiteCrawlItems.runId, crawlRunId),
				eq(geoSiteCrawlItems.outcome, "NEW_VERSION"),
				isNull(geoSiteCrawlItems.versionId),
			),
		);
	return row?.value ?? 0;
}

/** Takes the run for this worker; a second job for the same run, or a stale lease, finds nothing to take. */
async function claimRun(db: DbConnection, runId: string): Promise<SiteAuditRunRow | null> {
	const [run] = await db
		.update(geoSiteAuditRuns)
		.set({ status: "RUNNING", startedAt: sql`now()` })
		.where(
			and(
				eq(geoSiteAuditRuns.id, runId),
				or(
					eq(geoSiteAuditRuns.status, "QUEUED"),
					and(
						eq(geoSiteAuditRuns.status, "RUNNING"),
						lt(geoSiteAuditRuns.startedAt, sql`now() - ${RUNNING_STALE_MS}::int * interval '1 millisecond'`),
					),
				),
			),
		)
		.returning();
	return run ?? null;
}

function detectionCounts(actions: ReconcileAction[]) {
	return {
		inserted: actions.filter((action) => action.kind === "INSERT").length,
		refreshed: actions.filter((action) => action.kind === "REFRESH").length,
		reopened: actions.filter((action) => action.kind === "REFRESH" && action.reopened).length,
		resolved: actions.filter((action) => action.kind === "RESOLVE").length,
	};
}

async function auditSite(deps: SiteJobDeps, run: SiteAuditRunRow, pendingParse: number) {
	const { db } = deps;
	const source = await loadSiteSource(db, run.organizationId, run.siteSourceId);
	const profile = profileOfSource(source);
	const config = resolveAuditConfig(profile.audit);
	const pages = await loadPages(db, run.organizationId, source.id);
	const { facts, skipped } = await collectFacts(deps, source, profile, pages);

	const knownPages = new Map<string, KnownPage>(
		pages.map((page) => [
			page.normalizedUrl,
			{
				pageId: page.id,
				url: page.normalizedUrl,
				status: page.status,
				httpStatus: page.httpStatus,
				canonicalUrl: page.canonicalUrl,
			},
		]),
	);
	const pageResult = evaluatePageRules(facts, {
		config,
		allowedHosts: source.allowedHosts,
		knownPages,
		caseCategories: new Set(profile.categories.filter((c) => c.entityKind === "CASE").map((c) => c.key)),
		pageCategories: new Map(pages.map((page) => [page.id, page.category])),
	});

	const probes: SiteProbes | null = run.siteChecks ? await siteProbesFor(deps, source, run.organizationId) : null;
	const siteResult = probes
		? evaluateSiteChecks(probes, {
				config,
				allowedHosts: source.allowedHosts,
				knownPages,
				indexableUrls: facts.filter((page) => !page.noindex).map((page) => page.url),
			})
		: { detections: [], evaluatedRuleIds: [] };

	const detections = [...pageResult.detections, ...siteResult.detections];
	const actions = reconcileFindings(await existingFindings(db, source.id), detections, {
		pageRuleIds: pageResult.evaluatedRuleIds,
		auditedPageIds: new Set(facts.map((page) => page.pageId)),
		siteRuleIds: siteResult.evaluatedRuleIds,
		unavailablePageIds: new Set(
			pages.filter((page) => page.status !== "ACTIVE" && page.status !== "ERROR").map((page) => page.id),
		),
	});
	const writeContext: WriteContext = {
		run,
		factsByPage: new Map(facts.map((page) => [page.pageId, page])),
		prompts: await promptCandidates(db, run.organizationId),
	};
	const tally = detectionCounts(actions);
	const system = geoSystemPrincipal(run.organizationId, "site-audit", `audit-${run.id}`);

	await db.transaction(async (tx) => {
		await applyActions(tx, writeContext, actions);
		const counts: SiteAuditRunCounts = {
			pages: facts.length,
			skippedPages: skipped,
			detections: detections.length,
			...tally,
			open: await openCounts(tx, source.id),
			pendingParse,
			...(probes ? { site: probeSummary(probes, nowOf(deps)) } : {}),
		};
		await tx
			.update(geoSiteAuditRuns)
			.set({ status: "SUCCEEDED", finishedAt: sql`now()`, counts, errorSummary: null })
			.where(eq(geoSiteAuditRuns.id, run.id));
		await writeGeoAudit(tx, {
			principal: system,
			action: "site_audit.run.finish",
			entityType: "site_audit_run",
			entityId: run.id,
			after: { status: "SUCCEEDED", counts },
			metadata: {
				resolvedFindingIds: actions.flatMap((a) => (a.kind === "RESOLVE" ? [a.findingId] : [])).slice(0, 500),
				reopenedFindingIds: actions
					.flatMap((a) => (a.kind === "REFRESH" && a.reopened ? [a.findingId] : []))
					.slice(0, 500),
			},
		});
	});
	return tally;
}

/**
 * audit.site: reads the latest stored version of every active page (no page is
 * downloaded again), runs the rules, probes robots.txt, the sitemap and HTTPS
 * through the crawler's guarded and throttled fetch, then reconciles findings.
 */
export async function processSiteAuditRun(deps: SiteJobDeps, input: { organizationId: string; runId: string }) {
	const { db } = deps;
	const [queued] = await db
		.select()
		.from(geoSiteAuditRuns)
		.where(and(eq(geoSiteAuditRuns.organizationId, input.organizationId), eq(geoSiteAuditRuns.id, input.runId)))
		.limit(1);
	if (!queued || !ACTIVE_AUDIT_STATUSES.includes(queued.status)) return { status: queued?.status ?? null };

	const pendingParse = queued.crawlRunId ? await pendingParseCount(db, queued.crawlRunId) : 0;
	const waited = nowOf(deps).getTime() - queued.createdAt.getTime();
	if (queued.status === "QUEUED" && pendingParse > 0 && waited < PARSE_WAIT_MS) {
		await enqueueSiteAuditRun(deps.send, queued, {
			startAfter: new Date(nowOf(deps).getTime() + PARSE_RECHECK_MS),
			tag: `wait-${Math.floor(waited / PARSE_RECHECK_MS)}`,
		});
		return { status: "QUEUED" as const, waitingForParse: pendingParse };
	}

	const run = await claimRun(db, queued.id);
	if (!run) return { status: queued.status };
	try {
		const tally = await auditSite(deps, run, pendingParse);
		return { status: "SUCCEEDED" as const, ...tally };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await db
			.update(geoSiteAuditRuns)
			.set({ status: "FAILED", finishedAt: sql`now()`, errorSummary: message.slice(0, 500) })
			.where(eq(geoSiteAuditRuns.id, run.id));
		await writeGeoAudit(db, {
			principal: geoSystemPrincipal(run.organizationId, "site-audit", `audit-${run.id}`),
			action: "site_audit.run.fail",
			entityType: "site_audit_run",
			entityId: run.id,
			after: { status: "FAILED" },
			metadata: { error: message.slice(0, 500) },
		});
		throw error;
	}
}

/** DESIGN §6.3: a queued run whose job was lost, or a running one whose worker died, is queued again. */
export async function sweepStaleSiteAuditRuns(deps: Pick<SiteJobDeps, "db" | "send">): Promise<number> {
	const stale = await deps.db
		.select({ id: geoSiteAuditRuns.id, organizationId: geoSiteAuditRuns.organizationId })
		.from(geoSiteAuditRuns)
		.where(
			or(
				and(
					eq(geoSiteAuditRuns.status, "QUEUED"),
					lt(geoSiteAuditRuns.createdAt, sql`now() - ${QUEUED_STALE_MS}::int * interval '1 millisecond'`),
				),
				and(
					eq(geoSiteAuditRuns.status, "RUNNING"),
					lt(geoSiteAuditRuns.startedAt, sql`now() - ${RUNNING_STALE_MS}::int * interval '1 millisecond'`),
				),
			),
		)
		.limit(100);
	for (const run of stale) await enqueueSiteAuditRun(deps.send, run, { tag: "sweep" });
	return stale.length;
}

export async function loadSiteAuditRun(db: DbConnection, organizationId: string, runId: string) {
	const [run] = await db
		.select()
		.from(geoSiteAuditRuns)
		.where(and(eq(geoSiteAuditRuns.organizationId, organizationId), eq(geoSiteAuditRuns.id, runId)))
		.limit(1);
	if (!run) throw new GeoError("NOT_FOUND", "审计任务不存在");
	return run;
}
