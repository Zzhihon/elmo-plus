import {
	GEO_QUEUE,
	type GeoCrawlItemOutcome,
	type GeoCrawlItemSource,
	type GeoCrawlItemStatus,
	type GeoCrawlStatus,
	type GeoPrincipal,
	type GeoSitePageStatus,
	geoSystemPrincipal,
} from "@workspace/geo-domain";
import { geoObjectKey, normalizeUrl } from "@workspace/geo-evidence";
import type { DbConnection } from "@workspace/lib/db/db-connection";
import {
	geoSiteCrawlItems,
	geoSiteCrawlRuns,
	geoSitePages,
	geoSitePageVersions,
	geoSiteSources,
} from "@workspace/lib/db/schema";
import { raiseGeoAlert } from "@workspace/lib/geo/alerts";
import { writeGeoAudit } from "@workspace/lib/geo/audit";
import * as cheerio from "cheerio";
import { and, asc, count, desc, eq, inArray, ne, sql } from "drizzle-orm";
import {
	backoffMs,
	CRAWLER_PRODUCT_TOKEN,
	classifyStatus,
	decideVersion,
	HTML_MIME_TYPES,
	isRetryableResult,
	LIMITS,
	minIntervalMs,
	outcomeOfFailure,
	ROBOTS_MIME_TYPES,
	SITEMAP_MIME_TYPES,
	userAgentOf,
} from "../crawl-policy";
import { categoryOf, siteDiscovery } from "../discovery";
import { contentHashOf, sha256Hex } from "../hash";
import { decodeHtml, decodeSitemap } from "../net/charset";
import { isAllowedByRobots, parseRobots, type RobotsPolicy, robotsFromStatus } from "../net/robots";
import { type SafeFetchOptions, type SafeFetchResult, safeFetch } from "../net/safe-fetch";
import { checkUrl, urlPolicyOf } from "../net/url-policy";
import { parseOpWindow, parserVersionOf, type SiteProfile } from "../profile";
import { isWithinWindow, nextWindowStart } from "../schedule";
import { defaultSleep, nowOf, type SiteJobDeps } from "./deps";
import { finalizeCrawlRun } from "./finalize";
import {
	type CrawlRunConfig,
	type CrawlRunRow,
	claimCrawlRun,
	loadCrawlRun,
	releaseCrawlRun,
	renewCrawlRunLease,
	runConfigOf,
} from "./runs";
import { loadProfileVersion, profileOfSource, type SiteSourceRow } from "./sources";
import { fetchInHostSlots, type HostSlotRefusal } from "./throttle";
import { markPageUnavailable } from "./unavailable";

type ItemRow = typeof geoSiteCrawlItems.$inferSelect;

export type RobotsSummary = Pick<RobotsPolicy, "source" | "httpStatus" | "crawlDelaySeconds"> & { ruleCount: number };

/** Kept on the run between chunks and shown on it: what robots.txt and the sitemaps said. */
export interface CrawlRunMeta {
	robots?: RobotsSummary & Pick<RobotsPolicy, "sitemaps">;
	/** Every origin the run has asked, since each answers for itself (RFC 9309). */
	robotsByOrigin?: Record<string, RobotsSummary>;
	sitemap?: { files: string[]; urls: number; notFound: string[] };
	resumeAt?: string | null;
	breakerOpenUntil?: string | null;
	outOfScopeSamples?: string[];
	nofollowSkipped?: number;
	frontierCapped?: boolean;
}

interface CrawlContext {
	deps: SiteJobDeps;
	run: CrawlRunRow;
	config: CrawlRunConfig;
	source: SiteSourceRow;
	profile: SiteProfile;
	/** robots.txt by origin, filled as the run first reaches each one. */
	robots: Map<string, RobotsPolicy>;
	meta: CrawlRunMeta;
	system: GeoPrincipal;
	leaseHolder: string;
	userAgent: string;
	fetch: (url: string, options: SafeFetchOptions) => Promise<SafeFetchResult>;
	sleep: (ms: number) => Promise<void>;
	stop: { reason: "PAUSED" | "BREAKER" | "BUSY" | "DEFERRED" | "LEASE_LOST" | null; until?: Date };
}

type FetchOptions = Pick<SafeFetchOptions, "maxBytes" | "timeoutMs" | "allowedMimeTypes" | "accept">;

const PRIORITY: Record<GeoCrawlItemSource, number> = {
	SITEMAP: 0,
	SEED: 1,
	KNOWN: 1,
	CANONICAL: 1,
	REDIRECT: 1,
	PAGINATION: 1,
	LINK: 2,
};

function metaOf(run: CrawlRunRow): CrawlRunMeta {
	return ((run.counts as { meta?: CrawlRunMeta } | null)?.meta ?? {}) as CrawlRunMeta;
}

async function saveMeta(ctx: CrawlContext): Promise<void> {
	await ctx.deps.db
		.update(geoSiteCrawlRuns)
		.set({ counts: sql`jsonb_set(${geoSiteCrawlRuns.counts}, '{meta}', ${JSON.stringify(ctx.meta)}::jsonb, true)` })
		.where(eq(geoSiteCrawlRuns.id, ctx.run.id));
}

function pathAndQuery(url: string): string {
	const parsed = new URL(url);
	return `${parsed.pathname}${parsed.search}`;
}

function identityOf(url: string): string {
	return normalizeUrl(url) ?? url;
}

async function enqueueItems(
	ctx: CrawlContext,
	entries: Array<{ url: string; source: GeoCrawlItemSource; depth: number; isAsset?: boolean; from?: string | null }>,
): Promise<number> {
	if (entries.length === 0) return 0;
	const cap = ctx.config.maxPages * 3 + ctx.profile.assets.maxCount;
	const [{ value: existing }] = await ctx.deps.db
		.select({ value: count() })
		.from(geoSiteCrawlItems)
		.where(eq(geoSiteCrawlItems.runId, ctx.run.id));
	const room = cap - existing;
	if (room <= 0) {
		ctx.meta.frontierCapped = true;
		return 0;
	}
	const rows = entries.slice(0, room).map((entry) => ({
		organizationId: ctx.run.organizationId,
		runId: ctx.run.id,
		url: entry.url,
		source: entry.source,
		depth: entry.depth,
		priority: entry.isAsset ? 3 : PRIORITY[entry.source],
		isAsset: entry.isAsset ?? false,
		discoveredFrom: entry.from ?? null,
	}));
	if (entries.length > room) ctx.meta.frontierCapped = true;
	const inserted = await ctx.deps.db
		.insert(geoSiteCrawlItems)
		.values(rows)
		.onConflictDoNothing()
		.returning({ id: geoSiteCrawlItems.id });
	return inserted.length;
}

async function finishItem(
	ctx: CrawlContext,
	item: ItemRow,
	status: GeoCrawlItemStatus,
	outcome: GeoCrawlItemOutcome | null,
	extra: Partial<typeof geoSiteCrawlItems.$inferInsert> = {},
	db: DbConnection = ctx.deps.db,
): Promise<void> {
	await db
		.update(geoSiteCrawlItems)
		.set({ status, outcome, ...extra })
		.where(eq(geoSiteCrawlItems.id, item.id));
}

function intervalFor(ctx: CrawlContext, url: string): number {
	const delay = ctx.robots.get(new URL(url).origin)?.crawlDelaySeconds ?? null;
	return minIntervalMs(ctx.source.requestsPerSecond, delay);
}

function stopOfRefusal(refusal: HostSlotRefusal): CrawlContext["stop"] {
	if (refusal.reason === "CIRCUIT_OPEN") return { reason: "BREAKER", until: refusal.until };
	if (refusal.reason === "DEFERRED") return { reason: "DEFERRED", until: refusal.until };
	return { reason: "BUSY" };
}

async function fetchInSlot(
	ctx: CrawlContext,
	url: string,
	options: FetchOptions,
	vetRedirect?: (target: string) => Promise<string | null>,
): Promise<SafeFetchResult | null> {
	const paced = await fetchInHostSlots(ctx.deps, {
		url,
		options: { ...options, allowedHosts: ctx.source.allowedHosts, userAgent: ctx.userAgent },
		intervalFor: (target) => intervalFor(ctx, target),
		fetch: ctx.fetch,
		vetRedirect,
	});
	if (paced.refusal) {
		ctx.stop = stopOfRefusal(paced.refusal);
		return null;
	}
	// Stopping while asking a redirect target's robots.txt means the host is unavailable, not that the page moved.
	if (ctx.stop.reason) return null;
	const { result, health, host } = paced;
	if (health?.tripped) {
		await raiseGeoAlert(ctx.deps.db, {
			organizationId: ctx.run.organizationId,
			kind: "site.circuit_open",
			severity: "CRITICAL",
			dedupeKey: `site-circuit-open:${host}`,
			context: { host, siteSourceId: ctx.source.id, until: health.breakerOpenUntil, runId: ctx.run.id },
		});
	}
	if (health?.breakerOpenUntil && health.breakerOpenUntil.getTime() > Date.now()) {
		ctx.stop = { reason: "BREAKER", until: health.breakerOpenUntil };
	}
	return result;
}

/**
 * Every request for robots.txt, sitemaps, pages and attachments goes through
 * here: the shared per-host slot, then the guarded fetch, with limited
 * exponential backoff on timeouts, 5xx and 429, and the circuit breaker fed.
 */
async function politeFetch(
	ctx: CrawlContext,
	url: string,
	options: FetchOptions,
	vetRedirect?: (target: string) => Promise<string | null>,
): Promise<{ result: SafeFetchResult | null; attempts: number }> {
	for (let attempts = 1; ; attempts++) {
		if (!(await renewCrawlRunLease(ctx.deps.db, ctx.run.id, ctx.leaseHolder))) {
			ctx.stop = { reason: "LEASE_LOST" };
			return { result: null, attempts };
		}
		const result = await fetchInSlot(ctx, url, options, vetRedirect);
		const retry = result !== null && !ctx.stop.reason && isRetryableResult(result) && attempts < LIMITS.maxAttempts;
		if (!retry) return { result, attempts };
		await ctx.sleep(backoffMs(attempts, result.ok ? result.headers["retry-after"] : null));
	}
}

async function loadRobots(ctx: CrawlContext, origin: string): Promise<RobotsPolicy> {
	const { result } = await politeFetch(ctx, new URL("/robots.txt", origin).toString(), {
		maxBytes: LIMITS.robotsBytes,
		timeoutMs: LIMITS.fetchTimeoutMs,
		allowedMimeTypes: [...ROBOTS_MIME_TYPES],
		accept: "text/plain",
	});
	if (!result) return robotsFromStatus(null);
	if (!result.ok) return result.code === "MIME_REJECTED" ? robotsFromStatus(404) : robotsFromStatus(null);
	if (result.status >= 200 && result.status < 300) {
		return parseRobots(decodeHtml(result.body, result.charset).text, CRAWLER_PRODUCT_TOKEN, result.status);
	}
	return robotsFromStatus(result.status);
}

function robotsSummaryOf(policy: RobotsPolicy): RobotsSummary {
	return {
		source: policy.source,
		httpStatus: policy.httpStatus,
		crawlDelaySeconds: policy.crawlDelaySeconds,
		ruleCount: policy.rules.length,
	};
}

/** The policy of the URL's own origin, read once a run; null when the run was stopped before it could be read. */
async function robotsFor(ctx: CrawlContext, url: string): Promise<RobotsPolicy | null> {
	const { origin } = new URL(url);
	const known = ctx.robots.get(origin);
	if (known) return known;
	const policy = await loadRobots(ctx, origin);
	if (ctx.stop.reason) return null;
	ctx.robots.set(origin, policy);
	ctx.meta.robotsByOrigin = { ...ctx.meta.robotsByOrigin, [origin]: robotsSummaryOf(policy) };
	await ctx.deps.db
		.update(geoSiteCrawlRuns)
		.set({ robots: sql`${geoSiteCrawlRuns.robots} || ${JSON.stringify({ [origin]: policy })}::jsonb` })
		.where(eq(geoSiteCrawlRuns.id, ctx.run.id));
	return policy;
}

/** A redirect may land somewhere the target origin's robots.txt forbids; even `/news` to `/news/` can. */
async function robotsVeto(ctx: CrawlContext, target: string): Promise<string | null> {
	const policy = await robotsFor(ctx, target);
	if (!policy) return "robots.txt 未能读取";
	return isAllowedByRobots(policy, pathAndQuery(target)) ? null : "robots.txt 禁止访问重定向目标";
}

async function readSitemap(
	ctx: CrawlContext,
	sitemapUrl: string,
): Promise<{ pages: string[]; sitemaps: string[] } | null> {
	const { result } = await politeFetch(ctx, sitemapUrl, {
		maxBytes: LIMITS.sitemapBytes,
		timeoutMs: LIMITS.fetchTimeoutMs,
		allowedMimeTypes: [...SITEMAP_MIME_TYPES, "application/gzip", "application/x-gzip"],
		accept: "application/xml,text/xml;q=0.9,*/*;q=0.1",
	});
	if (!result?.ok || result.status < 200 || result.status >= 300) return null;
	try {
		return siteDiscovery.sitemapUrls(decodeSitemap(result, LIMITS.sitemapBytes), sitemapUrl);
	} catch {
		return null;
	}
}

async function loadSitemaps(ctx: CrawlContext, declared: string[]): Promise<string[]> {
	const queue = [...new Set([...declared, new URL("/sitemap.xml", ctx.source.baseUrl).toString()])];
	const files: string[] = [];
	const notFound: string[] = [];
	const pages = new Set<string>();
	while (queue.length > 0 && files.length < LIMITS.sitemapMaxFiles && !ctx.stop.reason) {
		const sitemapUrl = queue.shift() as string;
		if (!checkUrl(sitemapUrl, { allowedHosts: ctx.source.allowedHosts }).ok) continue;
		files.push(sitemapUrl);
		const found = await readSitemap(ctx, sitemapUrl);
		if (!found) {
			notFound.push(sitemapUrl);
			continue;
		}
		queue.push(...found.sitemaps.filter((nested) => !files.includes(nested)));
		for (const page of found.pages.slice(0, Math.max(LIMITS.sitemapMaxUrls - pages.size, 0))) pages.add(page);
	}
	ctx.meta.sitemap = { files, urls: pages.size, notFound };
	return [...pages];
}

/** First chunk of a run: robots.txt, then sitemap URLs first, then seeds, then pages already known. */
async function initializeFrontier(ctx: CrawlContext, declaredSitemaps: string[]): Promise<void> {
	const policy = urlPolicyOf(ctx.source.allowedHosts, ctx.profile);
	const accepted = (urls: string[]) =>
		urls.map((url) => checkUrl(url, policy)).flatMap((decision) => (decision.ok ? [decision.url] : []));

	if (ctx.config.seedUrls) {
		await enqueueItems(
			ctx,
			ctx.config.seedUrls.map((url) => ({ url, source: "SEED" as const, depth: 0 })),
		);
		return;
	}
	const sitemapPages = accepted(await loadSitemaps(ctx, declaredSitemaps));
	await enqueueItems(
		ctx,
		sitemapPages.map((url) => ({ url, source: "SITEMAP" as const, depth: 0 })),
	);
	await enqueueItems(
		ctx,
		accepted([ctx.source.baseUrl, ...ctx.source.seedUrls]).map((url) => ({ url, source: "SEED" as const, depth: 0 })),
	);
	const knownStatuses: GeoSitePageStatus[] =
		ctx.run.mode === "FULL" ? ["ACTIVE", "ERROR", "GONE", "BLOCKED"] : ["ACTIVE", "ERROR", "BLOCKED"];
	const known = await ctx.deps.db
		.select({ url: geoSitePages.normalizedUrl })
		.from(geoSitePages)
		.where(and(eq(geoSitePages.siteSourceId, ctx.source.id), inArray(geoSitePages.status, knownStatuses)))
		.orderBy(asc(geoSitePages.createdAt))
		.limit(ctx.config.maxPages * 2);
	await enqueueItems(
		ctx,
		accepted(known.map((row) => row.url)).map((url) => ({ url, source: "KNOWN" as const, depth: 1 })),
	);
}

async function upsertPage(
	ctx: CrawlContext,
	url: string,
	values: Partial<typeof geoSitePages.$inferInsert>,
	db: DbConnection = ctx.deps.db,
): Promise<{ page: typeof geoSitePages.$inferSelect; previousStatus: GeoSitePageStatus | null }> {
	const [before] = await db
		.select({ status: geoSitePages.status })
		.from(geoSitePages)
		.where(and(eq(geoSitePages.siteSourceId, ctx.source.id), eq(geoSitePages.normalizedUrl, url)))
		.limit(1);
	const [page] = await db
		.insert(geoSitePages)
		.values({
			organizationId: ctx.run.organizationId,
			siteSourceId: ctx.source.id,
			normalizedUrl: url,
			lastFetchedAt: nowOf(ctx.deps),
			...values,
		})
		.onConflictDoUpdate({
			target: [geoSitePages.organizationId, geoSitePages.siteSourceId, geoSitePages.normalizedUrl],
			set: { lastFetchedAt: nowOf(ctx.deps), ...values },
		})
		.returning();
	return { page, previousStatus: before?.status ?? null };
}

async function recordFailure(
	ctx: CrawlContext,
	url: string,
	status: GeoSitePageStatus | null,
	httpStatus: number | null,
): Promise<string | null> {
	const [existing] = await ctx.deps.db
		.select()
		.from(geoSitePages)
		.where(and(eq(geoSitePages.siteSourceId, ctx.source.id), eq(geoSitePages.normalizedUrl, url)))
		.limit(1);
	if (!existing) {
		if (!status) return null;
		const { page } = await upsertPage(ctx, url, { status, httpStatus, consecutiveFailures: 1 });
		return page.id;
	}
	const failures = existing.consecutiveFailures + 1;
	await ctx.deps.db
		.update(geoSitePages)
		.set({
			consecutiveFailures: failures,
			httpStatus: httpStatus ?? existing.httpStatus,
			lastFetchedAt: nowOf(ctx.deps),
			status: status ?? (failures >= LIMITS.maxAttempts ? "ERROR" : existing.status),
		})
		.where(eq(geoSitePages.id, existing.id));
	return existing.id;
}

async function auditBlocked(ctx: CrawlContext, action: string, metadata: Record<string, unknown>): Promise<void> {
	await writeGeoAudit(ctx.deps.db, {
		principal: ctx.system,
		action,
		entityType: "site_source",
		entityId: ctx.source.id,
		metadata: { runId: ctx.run.id, ...metadata },
	});
}

type PageRow = typeof geoSitePages.$inferSelect;

/**
 * Content unchanged but the rules moved on: the stored HTML is parsed again
 * with the current profile, which adds a version without downloading anything.
 */
async function reparseIfRulesChanged(ctx: CrawlContext, pageId: string, versionId: string | null): Promise<void> {
	if (!versionId) return;
	const [current] = await ctx.deps.db
		.select({ parserVersion: geoSitePageVersions.parserVersion, parseStatus: geoSitePageVersions.parseStatus })
		.from(geoSitePageVersions)
		.where(eq(geoSitePageVersions.id, versionId))
		.limit(1);
	if (!current || current.parseStatus === "SKIPPED" || current.parserVersion === parserVersionOf(ctx.profile)) return;
	const reparse = { pageId, versionId, profileVersion: ctx.profile.version };
	await ctx.deps.send(
		GEO_QUEUE.siteParse,
		{ organizationId: ctx.run.organizationId, reparse },
		{ singletonKey: `reparse:${pageId}:${versionId}:${ctx.profile.version}` },
	);
}

/** The page's own version of this content, preferring one parsed with the rules in force. */
async function ownVersionWithContent(
	ctx: CrawlContext,
	pageId: string,
	contentHash: string,
): Promise<{ id: string; parseStatus: string } | null> {
	const [row] = await ctx.deps.db
		.select({ id: geoSitePageVersions.id, parseStatus: geoSitePageVersions.parseStatus })
		.from(geoSitePageVersions)
		.where(and(eq(geoSitePageVersions.pageId, pageId), eq(geoSitePageVersions.contentHash, contentHash)))
		.orderBy(
			sql`${geoSitePageVersions.parserVersion} = ${parserVersionOf(ctx.profile)} desc`,
			desc(geoSitePageVersions.fetchedAt),
			desc(geoSitePageVersions.createdAt),
		)
		.limit(1);
	return row ?? null;
}

async function otherPageHasContent(ctx: CrawlContext, pageId: string, contentHash: string): Promise<boolean> {
	const [row] = await ctx.deps.db
		.select({ pageId: geoSitePageVersions.pageId })
		.from(geoSitePageVersions)
		.innerJoin(geoSitePages, eq(geoSitePages.id, geoSitePageVersions.pageId))
		.where(
			and(
				eq(geoSitePages.siteSourceId, ctx.source.id),
				eq(geoSitePageVersions.contentHash, contentHash),
				eq(geoSitePages.status, "ACTIVE"),
				ne(geoSitePages.id, pageId),
			),
		)
		.limit(1);
	return Boolean(row);
}

/**
 * The content changed back to something this page already has. No bytes are
 * stored and no version is minted: the old version simply becomes current, and
 * its facts are put through normalization again since the site asserts them anew.
 */
async function returnToVersion(
	ctx: CrawlContext,
	item: ItemRow,
	page: PageRow,
	version: { id: string; parseStatus: string },
	contentHash: string,
	common: Partial<typeof geoSiteCrawlItems.$inferInsert>,
): Promise<void> {
	await ctx.deps.db.transaction(async (tx) => {
		await tx
			.update(geoSitePages)
			.set({ currentContentHash: contentHash, currentVersionId: version.id })
			.where(eq(geoSitePages.id, page.id));
		await finishItem(
			ctx,
			item,
			"DONE",
			"REVERTED",
			{ ...common, contentHash, versionId: version.id, fetchedAt: nowOf(ctx.deps) },
			tx,
		);
		await writeGeoAudit(tx, {
			principal: ctx.system,
			action: "site.page.content_reverted",
			entityType: "site_page",
			entityId: page.id,
			before: { contentHash: page.currentContentHash, versionId: page.currentVersionId },
			after: { contentHash, versionId: version.id },
			metadata: { runId: ctx.run.id },
		});
	});
	await reparseIfRulesChanged(ctx, page.id, version.id);
	if (version.parseStatus === "PARSED") {
		await ctx.deps.send(
			GEO_QUEUE.siteNormalize,
			{ organizationId: ctx.run.organizationId, versionId: version.id },
			{ singletonKey: `normalize:${version.id}` },
		);
	}
}

function canFollowLinks(ctx: CrawlContext, item: ItemRow, metaNofollow: boolean): boolean {
	return (
		ctx.config.followLinks &&
		ctx.profile.scope.followLinks &&
		!(ctx.profile.respectNofollow && metaNofollow) &&
		item.depth < ctx.profile.scope.maxDepth
	);
}

function noteOutOfScope(ctx: CrawlContext, url: string): void {
	const samples = ctx.meta.outOfScopeSamples ?? [];
	if (samples.length < 50 && !samples.includes(url)) samples.push(url.slice(0, 300));
	ctx.meta.outOfScopeSamples = samples;
}

async function followLinks(ctx: CrawlContext, item: ItemRow, html: string, pageUrl: string, servedFrom: string) {
	const discovery = siteDiscovery.discover(html, servedFrom, ctx.profile);
	if (!canFollowLinks(ctx, item, discovery.metaNofollow)) return discovery;
	const policy = urlPolicyOf(ctx.source.allowedHosts, ctx.profile);
	const entries: Parameters<typeof enqueueItems>[1] = [];
	for (const link of discovery.links) {
		if (link.nofollow && ctx.profile.respectNofollow) {
			ctx.meta.nofollowSkipped = (ctx.meta.nofollowSkipped ?? 0) + 1;
			continue;
		}
		const decision = checkUrl(link.url, policy);
		if (!decision.ok) {
			noteOutOfScope(ctx, link.url);
			continue;
		}
		const pagination = link.kind === "PAGINATION";
		entries.push({
			url: decision.url,
			source: pagination ? "PAGINATION" : "LINK",
			depth: pagination ? item.depth : item.depth + 1,
			isAsset: link.kind === "ASSET",
			from: pageUrl,
		});
	}
	const canonical =
		discovery.canonical && discovery.canonical !== pageUrl ? checkUrl(discovery.canonical, policy) : null;
	if (canonical?.ok) entries.push({ url: canonical.url, source: "CANONICAL", depth: item.depth, from: pageUrl });
	await enqueueItems(ctx, entries);
	return discovery;
}

async function handleHtml(
	ctx: CrawlContext,
	item: ItemRow,
	result: Extract<SafeFetchResult, { ok: true }>,
	attempts: number,
): Promise<void> {
	const url = identityOf(result.finalUrl);
	const { text: html, charset } = decodeHtml(result.body, result.charset);
	const discovery = await followLinks(ctx, item, html, url, result.finalUrl);
	const category = categoryOf(url, ctx.profile, cheerio.load(html));
	const now = nowOf(ctx.deps);
	const canonical =
		discovery.canonical &&
		discovery.canonical !== url &&
		checkUrl(discovery.canonical, { allowedHosts: ctx.source.allowedHosts }).ok
			? discovery.canonical
			: null;
	const { page, previousStatus } = await upsertPage(ctx, url, {
		status: "ACTIVE",
		httpStatus: result.status,
		lastSeenAt: now,
		consecutiveFailures: 0,
		canonicalUrl: canonical,
		category: category?.key ?? null,
	});
	if (previousStatus && previousStatus !== "ACTIVE") {
		await writeGeoAudit(ctx.deps.db, {
			principal: ctx.system,
			action: "site.page.restored",
			entityType: "site_page",
			entityId: page.id,
			before: { status: previousStatus },
			after: { status: "ACTIVE" },
			metadata: { runId: ctx.run.id },
		});
	}
	const common = {
		attempts,
		durationMs: result.durationMs,
		httpStatus: result.status,
		pageId: page.id,
		finalUrl: result.finalUrl,
	};

	if (canonical) {
		await finishItem(ctx, item, "DONE", "DUPLICATE", { ...common, detail: `canonical → ${canonical}` });
		return;
	}
	const contentHash = contentHashOf(html, ctx.profile);
	const unchanged = page.currentContentHash === contentHash;
	const ownVersion = unchanged ? null : await ownVersionWithContent(ctx, page.id, contentHash);
	const decision = decideVersion({
		contentHash,
		currentHashOfPage: page.currentContentHash,
		hasVersionWithContent: ownVersion !== null,
		otherPageHasContent: !unchanged && !ownVersion && (await otherPageHasContent(ctx, page.id, contentHash)),
	});
	if (decision === "UNCHANGED") {
		await finishItem(ctx, item, "DONE", "UNCHANGED", { ...common, contentHash });
		await reparseIfRulesChanged(ctx, page.id, page.currentVersionId);
		return;
	}
	if (decision === "REVERTED" && ownVersion) {
		await returnToVersion(ctx, item, page, ownVersion, contentHash, common);
		return;
	}
	if (decision === "DUPLICATE") {
		await finishItem(ctx, item, "DONE", "DUPLICATE", { ...common, contentHash, detail: "与站内另一页面内容相同" });
		return;
	}
	const rawHash = sha256Hex(result.body);
	const key = geoObjectKey(ctx.run.organizationId, "site", ctx.source.id, "raw", `${rawHash}.html`);
	await ctx.deps.objectStore.put(key, result.body, { contentType: `text/html; charset=${charset}` });
	await ctx.deps.db.transaction(async (tx) => {
		await tx.update(geoSitePages).set({ currentContentHash: contentHash }).where(eq(geoSitePages.id, page.id));
		await finishItem(
			ctx,
			item,
			"DONE",
			"NEW_VERSION",
			{ ...common, contentHash, rawObjectKey: key, fetchedAt: now },
			tx,
		);
	});
	await ctx.deps.send(
		GEO_QUEUE.siteParse,
		{ organizationId: ctx.run.organizationId, itemId: item.id },
		{ singletonKey: `parse:${item.id}` },
	);
}

/** Back into the frontier untouched when the host could not be reached at all this time. */
async function requeue(ctx: CrawlContext, item: ItemRow): Promise<void> {
	await finishItem(ctx, item, "QUEUED", ctx.stop.reason === "BREAKER" ? "CIRCUIT_OPEN" : null, {
		attempts: Math.max(item.attempts - 1, 0),
	});
}

async function assetQuotaReached(ctx: CrawlContext): Promise<boolean> {
	const [{ value: stored }] = await ctx.deps.db
		.select({ value: count() })
		.from(geoSiteCrawlItems)
		.where(and(eq(geoSiteCrawlItems.runId, ctx.run.id), eq(geoSiteCrawlItems.outcome, "ASSET_STORED")));
	return stored >= ctx.profile.assets.maxCount;
}

function assetTitle(url: string): string {
	const name = new URL(url).pathname.split("/").pop() ?? "";
	try {
		return decodeURIComponent(name);
	} catch {
		return name;
	}
}

async function storeAsset(
	ctx: CrawlContext,
	item: ItemRow,
	result: Extract<SafeFetchResult, { ok: true }>,
	attempts: number,
): Promise<void> {
	const hash = sha256Hex(result.body);
	const url = identityOf(result.finalUrl);
	const extension = new URL(url).pathname.match(/\.[a-z0-9]{1,8}$/i)?.[0]?.toLowerCase() ?? ".bin";
	const key = geoObjectKey(ctx.run.organizationId, "site", ctx.source.id, "asset", `${hash}${extension}`);
	const now = nowOf(ctx.deps);
	const { page } = await upsertPage(ctx, url, {
		status: "ACTIVE",
		httpStatus: result.status,
		lastSeenAt: now,
		consecutiveFailures: 0,
		category: "attachment",
	});
	const existing = await ownVersionWithContent(ctx, page.id, hash);
	if (!existing)
		await ctx.deps.objectStore.put(key, result.body, { contentType: result.mimeType ?? "application/octet-stream" });
	const [inserted] = existing
		? []
		: await ctx.deps.db
				.insert(geoSitePageVersions)
				.values({
					organizationId: ctx.run.organizationId,
					pageId: page.id,
					contentHash: hash,
					parserVersion: "asset",
					htmlObjectKey: key,
					fetchedUrl: result.finalUrl,
					title: assetTitle(url),
					parsed: { mimeType: result.mimeType, size: result.body.length },
					fetchedAt: now,
					parseStatus: "SKIPPED",
				})
				.onConflictDoNothing()
				.returning({ id: geoSitePageVersions.id });
	const versionId = inserted?.id ?? existing?.id ?? null;
	await ctx.deps.db.transaction(async (tx) => {
		await tx
			.update(geoSitePages)
			.set({ currentContentHash: hash, currentVersionId: versionId })
			.where(eq(geoSitePages.id, page.id));
		const outcome: GeoCrawlItemOutcome = inserted
			? "ASSET_STORED"
			: page.currentContentHash === hash
				? "UNCHANGED"
				: "REVERTED";
		await finishItem(
			ctx,
			item,
			"DONE",
			outcome,
			{
				attempts,
				httpStatus: result.status,
				durationMs: result.durationMs,
				pageId: page.id,
				finalUrl: result.finalUrl,
				contentHash: hash,
				rawObjectKey: key,
				fetchedAt: now,
				versionId,
			},
			tx,
		);
	});
}

async function handleAsset(ctx: CrawlContext, item: ItemRow): Promise<void> {
	if (!ctx.profile.assets.download) {
		await finishItem(ctx, item, "SKIPPED", "ASSET_RECORDED", { detail: "附件只登记网址，未开启下载" });
		return;
	}
	if (await assetQuotaReached(ctx)) {
		await finishItem(ctx, item, "SKIPPED", "BUDGET_EXCEEDED", {
			detail: `附件数量达到上限 ${ctx.profile.assets.maxCount}`,
		});
		return;
	}
	const { result, attempts } = await politeFetch(
		ctx,
		item.url,
		{
			maxBytes: ctx.source.maxAssetBytes ?? LIMITS.defaultAssetBytes,
			timeoutMs: LIMITS.assetTimeoutMs,
			allowedMimeTypes: ctx.profile.assets.mimeTypes,
			accept: "*/*",
		},
		(target) => robotsVeto(ctx, target),
	);
	if (!result) {
		await requeue(ctx, item);
		return;
	}
	if (result.ok && result.status >= 200 && result.status < 300) {
		await storeAsset(ctx, item, result, attempts);
		return;
	}
	await finishItem(ctx, item, "FAILED", result.ok ? "CLIENT_ERROR" : outcomeOfFailure(result.code), {
		attempts,
		httpStatus: result.status ?? null,
		detail: result.ok ? `HTTP ${result.status}` : result.detail,
	});
}

type FetchSuccess = Extract<SafeFetchResult, { ok: true }>;
type FetchFailure = Extract<SafeFetchResult, { ok: false }>;

/**
 * The page's new status and whatever follows from it commit together: a failure
 * partway leaves the page as it was, so the retry still sees a page that just
 * went away and raises its review item. A page already known to be gone or moved
 * raises nothing new, and one never seen before has nothing to review.
 */
async function markPageGoneOrMoved(
	ctx: CrawlContext,
	url: string,
	kind: "GONE" | "REDIRECTED",
	values: Partial<typeof geoSitePages.$inferInsert>,
): Promise<PageRow> {
	return ctx.deps.db.transaction(async (tx) => {
		const { page, previousStatus } = await upsertPage(ctx, url, { status: kind, ...values }, tx);
		if (previousStatus && previousStatus !== "GONE" && previousStatus !== "REDIRECTED") {
			await markPageUnavailable(tx, ctx.system, page, kind);
		}
		return page;
	});
}

/** Where a refused redirect pointed, fit to show a person: it may name anything, credentials included. */
function displayableTarget(target: string | undefined): string | null {
	if (!target) return null;
	try {
		const url = new URL(target);
		url.username = "";
		url.password = "";
		return url.toString().slice(0, 2000);
	} catch {
		return null;
	}
}

/** The page answers with a redirect the crawl will not follow; for the page, that is having moved away (UAT-19). */
async function recordMovedAway(ctx: CrawlContext, item: ItemRow, result: FetchFailure): Promise<string> {
	const page = await markPageGoneOrMoved(ctx, item.url, "REDIRECTED", {
		httpStatus: result.status ?? null,
		canonicalUrl: displayableTarget(result.blockedTarget),
		lastSeenAt: nowOf(ctx.deps),
	});
	return page.id;
}

async function reportBlocked(ctx: CrawlContext, item: ItemRow, result: FetchFailure): Promise<void> {
	if (result.code !== "REDIRECT_BLOCKED" && result.code !== "ADDRESS_BLOCKED") return;
	await auditBlocked(ctx, result.code === "REDIRECT_BLOCKED" ? "site.redirect_blocked" : "site.address_blocked", {
		url: item.url,
		target: result.blockedTarget?.slice(0, 500) ?? null,
		reason: result.blockedReason ?? null,
		redirects: result.redirects.slice(0, 10),
	});
	if (result.code === "ADDRESS_BLOCKED") {
		await raiseGeoAlert(ctx.deps.db, {
			organizationId: ctx.run.organizationId,
			kind: "site.address_blocked",
			severity: "CRITICAL",
			dedupeKey: `site-address-blocked:${ctx.source.id}`,
			context: { url: item.url, detail: result.detail, runId: ctx.run.id },
		});
	}
}

async function handleFetchFailure(ctx: CrawlContext, item: ItemRow, result: FetchFailure, attempts: number) {
	await reportBlocked(ctx, item, result);
	const common = {
		attempts,
		durationMs: result.durationMs,
		httpStatus: result.status ?? null,
		detail: result.detail.slice(0, 500),
	};
	if (result.code === "REDIRECT_REFUSED") {
		// `/a` redirecting to a forbidden `/a/` is the same page: robots keeps it out, it has not moved.
		const samePage = identityOf(result.blockedTarget ?? "") === item.url;
		const pageId = samePage ? null : await recordMovedAway(ctx, item, result);
		await finishItem(ctx, item, "SKIPPED", "ROBOTS_DISALLOWED", { ...common, pageId });
		return;
	}
	const pageId =
		result.code === "REDIRECT_BLOCKED"
			? await recordMovedAway(ctx, item, result)
			: await recordFailure(ctx, item.url, result.code === "ADDRESS_BLOCKED" ? "BLOCKED" : null, result.status ?? null);
	await finishItem(ctx, item, "FAILED", outcomeOfFailure(result.code), { ...common, pageId });
}

/**
 * The requested URL now redirects inside the allowlist: it is recorded as
 * redirected (a moved page if it was live before), and the content that came
 * back is handled as the target URL's, claimed in this run so it is not fetched twice.
 */
async function followRedirect(
	ctx: CrawlContext,
	item: ItemRow,
	result: FetchSuccess,
	attempts: number,
): Promise<ItemRow | null> {
	const targetUrl = identityOf(result.finalUrl);
	const page = await markPageGoneOrMoved(ctx, item.url, "REDIRECTED", {
		httpStatus: result.redirects[0].status,
		canonicalUrl: targetUrl,
		lastSeenAt: nowOf(ctx.deps),
	});
	await finishItem(ctx, item, "DONE", "REDIRECTED", {
		attempts,
		httpStatus: result.redirects[0].status,
		pageId: page.id,
		finalUrl: result.finalUrl,
	});
	const [target] = await ctx.deps.db
		.insert(geoSiteCrawlItems)
		.values({
			organizationId: ctx.run.organizationId,
			runId: ctx.run.id,
			url: targetUrl,
			source: "REDIRECT",
			depth: item.depth,
			priority: PRIORITY.REDIRECT,
			discoveredFrom: item.url,
			status: "FETCHING",
			attempts: 1,
		})
		.onConflictDoUpdate({
			target: [geoSiteCrawlItems.runId, geoSiteCrawlItems.url],
			set: { status: "FETCHING" },
			setWhere: eq(geoSiteCrawlItems.status, "QUEUED"),
		})
		.returning();
	return target ?? null;
}

async function handleStatus(ctx: CrawlContext, item: ItemRow, result: FetchSuccess, attempts: number): Promise<void> {
	const kind = classifyStatus(result.status);
	const common = { attempts, durationMs: result.durationMs, httpStatus: result.status };
	if (kind.kind === "OK") {
		await handleHtml(ctx, item, result, attempts);
		return;
	}
	if (kind.kind === "GONE") {
		const page = await markPageGoneOrMoved(ctx, item.url, "GONE", { httpStatus: result.status });
		await finishItem(ctx, item, "DONE", "GONE", { ...common, pageId: page.id });
		return;
	}
	if (kind.kind === "AUTH_REQUIRED") {
		const pageId = await recordFailure(ctx, item.url, "BLOCKED", result.status);
		await finishItem(ctx, item, "FAILED", "AUTH_REQUIRED", { ...common, pageId, detail: "需要鉴权，不尝试登录或绕过" });
		return;
	}
	const outcome: GeoCrawlItemOutcome = kind.kind === "RETRYABLE" ? kind.outcome : "CLIENT_ERROR";
	const pageId = await recordFailure(ctx, item.url, kind.kind === "CLIENT_ERROR" ? "ERROR" : null, result.status);
	await finishItem(ctx, item, "FAILED", outcome, { ...common, pageId, detail: `HTTP ${result.status}` });
}

async function processItem(ctx: CrawlContext, item: ItemRow): Promise<void> {
	const robots = await robotsFor(ctx, item.url);
	if (!robots) {
		await requeue(ctx, item);
		return;
	}
	if (!isAllowedByRobots(robots, pathAndQuery(item.url))) {
		await finishItem(ctx, item, "SKIPPED", "ROBOTS_DISALLOWED", {
			detail: robots.source === "UNAVAILABLE" ? "该主机的 robots.txt 无法获取，按 RFC 9309 不采集" : null,
		});
		return;
	}
	if (item.isAsset) {
		await handleAsset(ctx, item);
		return;
	}
	const { result, attempts } = await politeFetch(
		ctx,
		item.url,
		{
			maxBytes: LIMITS.htmlBytes,
			timeoutMs: LIMITS.fetchTimeoutMs,
			allowedMimeTypes: [...HTML_MIME_TYPES],
		},
		(target) => robotsVeto(ctx, target),
	);
	if (!result) {
		await requeue(ctx, item);
		return;
	}
	if (!result.ok) {
		await handleFetchFailure(ctx, item, result, attempts);
		return;
	}
	let current: ItemRow | null = item;
	if (result.redirects.length > 0 && identityOf(result.finalUrl) !== item.url) {
		current = await followRedirect(ctx, item, result, attempts);
	}
	if (current) await handleStatus(ctx, current, result, attempts);
}

async function claimNextItem(ctx: CrawlContext): Promise<ItemRow | null> {
	const result = await ctx.deps.db.execute<{ id: string }>(sql`
		update ${geoSiteCrawlItems}
		set status = 'FETCHING', attempts = attempts + 1, updated_at = now()
		where id = (
			select id from ${geoSiteCrawlItems}
			where run_id = ${ctx.run.id} and status = 'QUEUED'
			order by priority asc, depth asc, created_at asc
			limit 1
			for update skip locked
		)
		returning id`);
	const id = result.rows[0]?.id;
	if (!id) return null;
	const [item] = await ctx.deps.db.select().from(geoSiteCrawlItems).where(eq(geoSiteCrawlItems.id, id)).limit(1);
	return item ?? null;
}

async function fetchedPageCount(ctx: CrawlContext): Promise<number> {
	const [{ value }] = await ctx.deps.db
		.select({ value: count() })
		.from(geoSiteCrawlItems)
		.where(
			and(
				eq(geoSiteCrawlItems.runId, ctx.run.id),
				eq(geoSiteCrawlItems.isAsset, false),
				inArray(geoSiteCrawlItems.status, ["DONE", "FAILED"]),
				ne(geoSiteCrawlItems.outcome, "REDIRECTED"),
			),
		);
	return value;
}

async function currentStatus(ctx: CrawlContext): Promise<GeoCrawlStatus | null> {
	const [row] = await ctx.deps.db
		.select({ status: geoSiteCrawlRuns.status })
		.from(geoSiteCrawlRuns)
		.where(eq(geoSiteCrawlRuns.id, ctx.run.id))
		.limit(1);
	return row?.status ?? null;
}

function sendCrawlJob(deps: SiteJobDeps, run: CrawlRunRow, startAfter?: Date) {
	return deps.send(
		GEO_QUEUE.siteCrawl,
		{ organizationId: run.organizationId, runId: run.id },
		startAfter ? { startAfter } : {},
	);
}

/**
 * A pause ends the chunk; a tripped breaker ends the run; a busy host, or one
 * that may not be asked again yet, is tried again later from a fresh job; a lost
 * lease means another chunk has taken over and has nothing to hear from this one.
 */
async function stopEarly(ctx: CrawlContext, processed: number): Promise<CrawlChunkResult> {
	const { deps, run } = ctx;
	if (ctx.stop.reason === "PAUSED") return { status: "PAUSED", continued: false, processed };
	if (ctx.stop.reason === "LEASE_LOST") return { status: "RUNNING", continued: false, processed };
	if (ctx.stop.reason === "BREAKER") {
		ctx.meta.breakerOpenUntil = ctx.stop.until?.toISOString() ?? null;
		await saveMeta(ctx);
		return finalizeCrawlRun(deps, run.id, {
			forcedStatus: "PARTIAL",
			errorSummary: `源站连续失败触发熔断，${ctx.stop.until?.toISOString() ?? ""} 前不再请求`,
		});
	}
	await sendCrawlJob(deps, run, ctx.stop.reason === "DEFERRED" ? ctx.stop.until : new Date(Date.now() + 30_000));
	return { status: "RUNNING", continued: true, processed };
}

export interface CrawlChunkResult {
	status: GeoCrawlStatus;
	continued: boolean;
	processed: number;
}

async function deferUntilWindow(deps: SiteJobDeps, run: CrawlRunRow, meta: CrawlRunMeta, resumeAt: Date) {
	meta.resumeAt = resumeAt.toISOString();
	await deps.db
		.update(geoSiteCrawlRuns)
		.set({
			status: "QUEUED",
			counts: sql`jsonb_set(${geoSiteCrawlRuns.counts}, '{meta}', ${JSON.stringify(meta)}::jsonb, true)`,
		})
		.where(eq(geoSiteCrawlRuns.id, run.id));
	await sendCrawlJob(deps, run, resumeAt);
	return { status: "QUEUED" as const, continued: true, processed: 0 };
}

/** Prepares a run this chunk holds the lease of and marks it running, or says why this chunk should not run. */
async function openRun(
	deps: SiteJobDeps,
	run: CrawlRunRow,
	leaseHolder: string,
): Promise<{ ctx: CrawlContext } | { done: CrawlChunkResult }> {
	const [source] = await deps.db.select().from(geoSiteSources).where(eq(geoSiteSources.id, run.siteSourceId)).limit(1);
	if (!source?.enabled) {
		await deps.db
			.update(geoSiteCrawlRuns)
			.set({ status: "PAUSED", errorSummary: "站点采集已暂停" })
			.where(eq(geoSiteCrawlRuns.id, run.id));
		return { done: { status: "PAUSED", continued: false, processed: 0 } };
	}
	const config = runConfigOf(run);
	const meta = metaOf(run);
	const window = parseOpWindow(source.opWindow);
	if (window && !isWithinWindow(window, nowOf(deps))) {
		return { done: await deferUntilWindow(deps, run, meta, nextWindowStart(window, nowOf(deps))) };
	}
	const [started] = await deps.db
		.update(geoSiteCrawlRuns)
		.set({ status: "RUNNING", startedAt: sql`coalesce(${geoSiteCrawlRuns.startedAt}, now())` })
		.where(and(eq(geoSiteCrawlRuns.id, run.id), inArray(geoSiteCrawlRuns.status, ["QUEUED", "RUNNING"])))
		.returning();
	if (!started) return { done: { status: run.status, continued: false, processed: 0 } };
	const profile = await loadProfileVersion(deps.db, run.organizationId, source.id, config.profileVersion).catch(() =>
		profileOfSource(source),
	);
	meta.resumeAt = null;
	// Holding the lease means nobody else is working this run: anything still fetching was abandoned.
	await deps.db
		.update(geoSiteCrawlItems)
		.set({ status: "QUEUED" })
		.where(and(eq(geoSiteCrawlItems.runId, run.id), eq(geoSiteCrawlItems.status, "FETCHING")));
	return {
		ctx: {
			deps,
			run: started,
			config,
			source,
			profile,
			robots: new Map(Object.entries((started.robots ?? {}) as Record<string, RobotsPolicy>)),
			meta,
			system: geoSystemPrincipal(run.organizationId, "site-crawl", `crawl-${run.id}`),
			leaseHolder,
			userAgent: userAgentOf(source.userAgentContact),
			fetch: deps.fetch ?? safeFetch,
			sleep: deps.sleep ?? defaultSleep,
			stop: { reason: null },
		},
	};
}

/** First chunk only: the site's own robots.txt decides whether the run may proceed, then the frontier is seeded. */
async function ensureFrontier(ctx: CrawlContext): Promise<CrawlChunkResult | null> {
	if (ctx.meta.robots) return null;
	const robots = await robotsFor(ctx, ctx.source.baseUrl);
	if (!robots) return stopEarly(ctx, 0);
	const summary = { ...robotsSummaryOf(robots), sitemaps: robots.sitemaps.slice(0, 20) };
	if (robots.source === "UNAVAILABLE") {
		ctx.meta.robots = summary;
		await saveMeta(ctx);
		return finalizeCrawlRun(ctx.deps, ctx.run.id, {
			forcedStatus: "FAILED",
			errorSummary: "robots.txt 无法获取（5xx 或网络错误），按 RFC 9309 暂不采集全站",
		});
	}
	await initializeFrontier(ctx, robots.sitemaps);
	if (ctx.stop.reason) return stopEarly(ctx, 0);
	ctx.meta.robots = summary;
	await saveMeta(ctx);
	return null;
}

async function skipRemaining(ctx: CrawlContext): Promise<void> {
	await ctx.deps.db
		.update(geoSiteCrawlItems)
		.set({ status: "SKIPPED", outcome: "BUDGET_EXCEEDED" })
		.where(and(eq(geoSiteCrawlItems.runId, ctx.run.id), eq(geoSiteCrawlItems.status, "QUEUED")));
}

/** A resume that arrives during a chunk leaves the run queued, and its job finds this chunk's lease and gives way. */
async function stillRunning(ctx: CrawlContext): Promise<boolean> {
	const status = await currentStatus(ctx);
	if (status === "RUNNING") return true;
	if (status !== "QUEUED") return false;
	const [resumed] = await ctx.deps.db
		.update(geoSiteCrawlRuns)
		.set({ status: "RUNNING" })
		.where(and(eq(geoSiteCrawlRuns.id, ctx.run.id), eq(geoSiteCrawlRuns.status, "QUEUED")))
		.returning({ id: geoSiteCrawlRuns.id });
	return Boolean(resumed);
}

/** Works the frontier until the slice ends, the budget is spent, the window closes or something stops it. */
async function crawlSlice(ctx: CrawlContext): Promise<number> {
	const deadline = Date.now() + LIMITS.chunkMs;
	const window = parseOpWindow(ctx.source.opWindow);
	let processed = 0;
	while (!ctx.stop.reason && Date.now() < deadline) {
		if (!(await stillRunning(ctx))) {
			ctx.stop = { reason: "PAUSED" };
			break;
		}
		if ((await fetchedPageCount(ctx)) >= ctx.config.maxPages) {
			await skipRemaining(ctx);
			break;
		}
		if (window && !isWithinWindow(window, nowOf(ctx.deps))) break;
		const item = await claimNextItem(ctx);
		if (!item) break;
		await processItem(ctx, item);
		processed++;
	}
	return processed;
}

async function runChunk(deps: SiteJobDeps, run: CrawlRunRow, leaseHolder: string): Promise<CrawlChunkResult> {
	const opened = await openRun(deps, run, leaseHolder);
	if ("done" in opened) return opened.done;
	const { ctx } = opened;
	const early = await ensureFrontier(ctx);
	if (early) return early;

	const processed = await crawlSlice(ctx);
	await saveMeta(ctx);
	if (ctx.stop.reason) return stopEarly(ctx, processed);

	const [{ value: unfinished }] = await deps.db
		.select({ value: count() })
		.from(geoSiteCrawlItems)
		.where(and(eq(geoSiteCrawlItems.runId, ctx.run.id), inArray(geoSiteCrawlItems.status, ["QUEUED", "FETCHING"])));
	if (unfinished > 0) {
		await sendCrawlJob(deps, ctx.run);
		return { status: "RUNNING", continued: true, processed };
	}
	return finalizeCrawlRun(deps, ctx.run.id, {});
}

/**
 * One slice of a crawl run. It works through the frontier until the time slice
 * is used up, then sends itself again; pausing, the operating window, the page
 * budget and the circuit breaker are all checked between pages, and everything
 * needed to resume lives in the database rather than in this process.
 *
 * The queue may deliver a run's job more than once (a repeated start, a recovery
 * sweep, a retry), so the lease on the run row is what makes it safe: a job that
 * cannot take it returns without touching anything, and the holder finishes.
 */
export async function processCrawlRun(
	deps: SiteJobDeps,
	input: { organizationId: string; runId: string },
): Promise<CrawlChunkResult> {
	const claim = await claimCrawlRun(deps, input.organizationId, input.runId);
	if (!claim) {
		const run = await loadCrawlRun(deps.db, input.organizationId, input.runId);
		return { status: run.status, continued: false, processed: 0 };
	}
	let outcome: CrawlChunkResult;
	try {
		outcome = await runChunk(deps, claim.run, claim.holder);
	} finally {
		await releaseCrawlRun(deps.db, claim.run.id, claim.holder);
	}
	if (outcome.status === "PAUSED") {
		const [run] = await deps.db
			.select({ status: geoSiteCrawlRuns.status })
			.from(geoSiteCrawlRuns)
			.where(eq(geoSiteCrawlRuns.id, claim.run.id))
			.limit(1);
		// Resumed in the moment between this chunk's last look and its release: that job already gave way.
		if (run?.status === "QUEUED") await sendCrawlJob(deps, claim.run);
	}
	return outcome;
}
