import { gunzipSync } from "node:zlib";
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
import { geoObjectKey } from "@workspace/geo-evidence";
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
import { and, asc, count, desc, eq, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import {
	backoffMs,
	CRAWLER_PRODUCT_TOKEN,
	classifyStatus,
	decideVersion,
	HTML_MIME_TYPES,
	isRetryableFailure,
	LIMITS,
	minIntervalMs,
	outcomeOfFailure,
	ROBOTS_MIME_TYPES,
	SITEMAP_MIME_TYPES,
	userAgentOf,
} from "../crawl-policy";
import { categoryOf, siteDiscovery } from "../discovery";
import { contentHashOf, sha256Hex } from "../hash";
import { decodeHtml } from "../net/charset";
import { isAllowedByRobots, parseRobots, type RobotsPolicy, robotsFromStatus } from "../net/robots";
import { type SafeFetchOptions, type SafeFetchResult, safeFetch } from "../net/safe-fetch";
import { checkUrl, urlPolicyOf } from "../net/url-policy";
import { parseOpWindow, type SiteProfile } from "../profile";
import { isWithinWindow, nextWindowStart } from "../schedule";
import { defaultSleep, nowOf, type SiteJobDeps } from "./deps";
import { finalizeCrawlRun } from "./finalize";
import { crawlJobOptions, type CrawlRunConfig, type CrawlRunRow, loadCrawlRun, runConfigOf } from "./runs";
import { loadProfileVersion, profileOfSource, type SiteSourceRow } from "./sources";
import { acquireHostSlot } from "./throttle";
import { markPageUnavailable } from "./unavailable";

type ItemRow = typeof geoSiteCrawlItems.$inferSelect;

/** Kept on the run between chunks: what robots.txt and the sitemaps said. */
export interface CrawlRunMeta {
	robots?: Pick<RobotsPolicy, "source" | "httpStatus" | "crawlDelaySeconds" | "sitemaps"> & {
		rules: RobotsPolicy["rules"];
	};
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
	robots: RobotsPolicy;
	meta: CrawlRunMeta;
	system: GeoPrincipal;
	interval: number;
	userAgent: string;
	fetch: (url: string, options: SafeFetchOptions) => Promise<SafeFetchResult>;
	sleep: (ms: number) => Promise<void>;
	stop: { reason: "PAUSED" | "BREAKER" | "BUSY" | null; breakerUntil?: Date };
}

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
): Promise<void> {
	await ctx.deps.db
		.update(geoSiteCrawlItems)
		.set({ status, outcome, ...extra })
		.where(eq(geoSiteCrawlItems.id, item.id));
}

/**
 * Every request for robots.txt, sitemaps, pages and attachments goes through
 * here: the shared per-host slot, then the guarded fetch, with limited
 * exponential backoff on timeouts, 5xx and 429, and the circuit breaker fed.
 */
async function politeFetch(
	ctx: CrawlContext,
	url: string,
	options: Pick<SafeFetchOptions, "maxBytes" | "timeoutMs" | "allowedMimeTypes" | "accept">,
): Promise<{ result: SafeFetchResult | null; attempts: number }> {
	const host = new URL(url).hostname;
	let attempts = 0;
	for (;;) {
		attempts++;
		const slot = await acquireHostSlot(ctx.deps, host, ctx.interval);
		if (!slot.ok) {
			if (slot.reason === "CIRCUIT_OPEN") ctx.stop = { reason: "BREAKER", breakerUntil: slot.until };
			else ctx.stop = { reason: "BUSY" };
			return { result: null, attempts };
		}
		let result: SafeFetchResult;
		try {
			result = await ctx.fetch(url, { ...options, allowedHosts: ctx.source.allowedHosts, userAgent: ctx.userAgent });
		} catch (error) {
			await slot.release(false);
			throw error;
		}
		const retryableStatus = result.ok && classifyStatus(result.status).kind === "RETRYABLE";
		const retryableFailure = !result.ok && isRetryableFailure(result.code);
		const health = await slot.release(!(retryableStatus || retryableFailure));
		if (health.tripped) {
			await raiseGeoAlert(ctx.deps.db, {
				organizationId: ctx.run.organizationId,
				kind: "site.circuit_open",
				severity: "CRITICAL",
				dedupeKey: `site-circuit-open:${host}`,
				context: { host, siteSourceId: ctx.source.id, until: health.breakerOpenUntil, runId: ctx.run.id },
			});
		}
		if (health.breakerOpenUntil && health.breakerOpenUntil.getTime() > Date.now()) {
			ctx.stop = { reason: "BREAKER", breakerUntil: health.breakerOpenUntil };
			return { result, attempts };
		}
		if ((retryableStatus || retryableFailure) && attempts < LIMITS.maxAttempts) {
			const retryAfter = result.ok ? result.headers["retry-after"] : null;
			await ctx.sleep(backoffMs(attempts, retryAfter));
			continue;
		}
		return { result, attempts };
	}
}

async function loadRobots(ctx: CrawlContext): Promise<RobotsPolicy> {
	const robotsUrl = new URL("/robots.txt", ctx.source.baseUrl).toString();
	const { result } = await politeFetch(ctx, robotsUrl, {
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

function sitemapBody(result: Extract<SafeFetchResult, { ok: true }>): string {
	if (result.mimeType === "application/gzip" || result.mimeType === "application/x-gzip") {
		return gunzipSync(result.body, { maxOutputLength: LIMITS.sitemapBytes }).toString("utf8");
	}
	return decodeHtml(result.body, result.charset).text;
}

async function loadSitemaps(ctx: CrawlContext): Promise<string[]> {
	const queue = [...new Set([...ctx.robots.sitemaps, new URL("/sitemap.xml", ctx.source.baseUrl).toString()])];
	const files: string[] = [];
	const notFound: string[] = [];
	const pages = new Set<string>();
	while (queue.length > 0 && files.length < LIMITS.sitemapMaxFiles && !ctx.stop.reason) {
		const sitemapUrl = queue.shift() as string;
		if (!checkUrl(sitemapUrl, { allowedHosts: ctx.source.allowedHosts }).ok) continue;
		files.push(sitemapUrl);
		const { result } = await politeFetch(ctx, sitemapUrl, {
			maxBytes: LIMITS.sitemapBytes,
			timeoutMs: LIMITS.fetchTimeoutMs,
			allowedMimeTypes: [...SITEMAP_MIME_TYPES, "application/gzip", "application/x-gzip"],
			accept: "application/xml,text/xml;q=0.9,*/*;q=0.1",
		});
		if (!result?.ok || result.status < 200 || result.status >= 300) {
			notFound.push(sitemapUrl);
			continue;
		}
		try {
			const found = siteDiscovery.sitemapUrls(sitemapBody(result), sitemapUrl);
			for (const nested of found.sitemaps) if (!files.includes(nested)) queue.push(nested);
			for (const page of found.pages) if (pages.size < LIMITS.sitemapMaxUrls) pages.add(page);
		} catch {
			notFound.push(sitemapUrl);
		}
	}
	ctx.meta.sitemap = { files, urls: pages.size, notFound };
	return [...pages];
}

/** First chunk of a run: robots.txt, then sitemap URLs first, then seeds, then pages already known. */
async function initializeFrontier(ctx: CrawlContext): Promise<void> {
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
	const sitemapPages = accepted(await loadSitemaps(ctx));
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
): Promise<{ page: typeof geoSitePages.$inferSelect; previousStatus: GeoSitePageStatus | null }> {
	const [before] = await ctx.deps.db
		.select({ status: geoSitePages.status })
		.from(geoSitePages)
		.where(and(eq(geoSitePages.siteSourceId, ctx.source.id), eq(geoSitePages.normalizedUrl, url)))
		.limit(1);
	const [page] = await ctx.deps.db
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

async function latestHashOf(ctx: CrawlContext, pageId: string): Promise<string | null> {
	const [version] = await ctx.deps.db
		.select({ contentHash: geoSitePageVersions.contentHash })
		.from(geoSitePageVersions)
		.where(eq(geoSitePageVersions.pageId, pageId))
		.orderBy(desc(geoSitePageVersions.fetchedAt), desc(geoSitePageVersions.createdAt))
		.limit(1);
	if (version) return version.contentHash;
	const [pending] = await ctx.deps.db
		.select({ contentHash: geoSiteCrawlItems.contentHash })
		.from(geoSiteCrawlItems)
		.where(
			and(
				eq(geoSiteCrawlItems.pageId, pageId),
				eq(geoSiteCrawlItems.outcome, "NEW_VERSION"),
				isNull(geoSiteCrawlItems.versionId),
			),
		)
		.orderBy(desc(geoSiteCrawlItems.fetchedAt))
		.limit(1);
	return pending?.contentHash ?? null;
}

async function pageWithSameContent(ctx: CrawlContext, contentHash: string): Promise<string | null> {
	const [row] = await ctx.deps.db
		.select({ pageId: geoSitePageVersions.pageId })
		.from(geoSitePageVersions)
		.innerJoin(geoSitePages, eq(geoSitePages.id, geoSitePageVersions.pageId))
		.where(
			and(
				eq(geoSitePages.siteSourceId, ctx.source.id),
				eq(geoSitePageVersions.contentHash, contentHash),
				eq(geoSitePages.status, "ACTIVE"),
			),
		)
		.limit(1);
	return row?.pageId ?? null;
}

async function followLinks(ctx: CrawlContext, item: ItemRow, html: string, pageUrl: string) {
	const discovery = siteDiscovery.discover(html, pageUrl, ctx.profile);
	const canFollow =
		ctx.config.followLinks &&
		ctx.profile.scope.followLinks &&
		!(ctx.profile.respectNofollow && discovery.metaNofollow) &&
		item.depth < ctx.profile.scope.maxDepth;
	if (!canFollow) return discovery;
	const policy = urlPolicyOf(ctx.source.allowedHosts, ctx.profile);
	const entries: Parameters<typeof enqueueItems>[1] = [];
	for (const link of discovery.links) {
		if (link.nofollow && ctx.profile.respectNofollow) {
			ctx.meta.nofollowSkipped = (ctx.meta.nofollowSkipped ?? 0) + 1;
			continue;
		}
		const decision = checkUrl(link.url, policy);
		if (!decision.ok) {
			const samples = ctx.meta.outOfScopeSamples ?? [];
			if (samples.length < 50 && !samples.includes(link.url)) samples.push(link.url.slice(0, 300));
			ctx.meta.outOfScopeSamples = samples;
			continue;
		}
		entries.push({
			url: decision.url,
			source: link.kind === "PAGINATION" ? "PAGINATION" : "LINK",
			depth: link.kind === "PAGINATION" ? item.depth : item.depth + 1,
			isAsset: link.kind === "ASSET",
			from: pageUrl,
		});
	}
	if (discovery.canonical && discovery.canonical !== pageUrl) {
		const decision = checkUrl(discovery.canonical, policy);
		if (decision.ok) entries.push({ url: decision.url, source: "CANONICAL", depth: item.depth, from: pageUrl });
	}
	await enqueueItems(ctx, entries);
	return discovery;
}

async function handleHtml(
	ctx: CrawlContext,
	item: ItemRow,
	result: Extract<SafeFetchResult, { ok: true }>,
	attempts: number,
): Promise<void> {
	const url = result.finalUrl;
	const { text: html } = decodeHtml(result.body, result.charset);
	const discovery = await followLinks(ctx, item, html, url);
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
	const common = { attempts, durationMs: result.durationMs, httpStatus: result.status, pageId: page.id, finalUrl: url };

	if (canonical) {
		await finishItem(ctx, item, "DONE", "DUPLICATE", { ...common, detail: `canonical → ${canonical}` });
		return;
	}
	const contentHash = contentHashOf(html, ctx.profile);
	const decision = decideVersion({
		contentHash,
		latestHashOfPage: await latestHashOf(ctx, page.id),
		pageWithSameContent: await pageWithSameContent(ctx, contentHash),
		pageId: page.id,
	});
	if (decision === "UNCHANGED") {
		await finishItem(ctx, item, "DONE", "UNCHANGED", { ...common, contentHash });
		return;
	}
	if (decision === "DUPLICATE") {
		await finishItem(ctx, item, "DONE", "DUPLICATE", { ...common, contentHash, detail: "与站内另一页面内容相同" });
		return;
	}
	const rawHash = sha256Hex(result.body);
	const key = geoObjectKey(ctx.run.organizationId, "site", ctx.source.id, "raw", `${rawHash}.html`);
	await ctx.deps.objectStore.put(key, result.body, {
		contentType: `text/html; charset=${result.charset ?? "utf-8"}`,
	});
	await finishItem(ctx, item, "DONE", "NEW_VERSION", {
		...common,
		contentHash,
		rawObjectKey: key,
		fetchedAt: now,
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

async function handleAsset(ctx: CrawlContext, item: ItemRow): Promise<void> {
	if (!ctx.profile.assets.download) {
		await finishItem(ctx, item, "SKIPPED", "ASSET_RECORDED", { detail: "附件只登记网址，未开启下载" });
		return;
	}
	const [{ value: stored }] = await ctx.deps.db
		.select({ value: count() })
		.from(geoSiteCrawlItems)
		.where(and(eq(geoSiteCrawlItems.runId, ctx.run.id), eq(geoSiteCrawlItems.outcome, "ASSET_STORED")));
	if (stored >= ctx.profile.assets.maxCount) {
		await finishItem(ctx, item, "SKIPPED", "BUDGET_EXCEEDED", { detail: `附件数量达到上限 ${ctx.profile.assets.maxCount}` });
		return;
	}
	const { result, attempts } = await politeFetch(ctx, item.url, {
		maxBytes: ctx.source.maxAssetBytes ?? LIMITS.defaultAssetBytes,
		timeoutMs: LIMITS.assetTimeoutMs,
		allowedMimeTypes: ctx.profile.assets.mimeTypes,
		accept: "*/*",
	});
	if (!result) {
		await requeue(ctx, item);
		return;
	}
	if (!result.ok || result.status < 200 || result.status >= 300) {
		const outcome = result.ok ? "CLIENT_ERROR" : outcomeOfFailure(result.code);
		await finishItem(ctx, item, "FAILED", outcome, {
			attempts,
			httpStatus: result.ok ? result.status : (result.status ?? null),
			detail: result.ok ? `HTTP ${result.status}` : result.detail,
		});
		return;
	}
	const hash = sha256Hex(result.body);
	const extension = new URL(result.finalUrl).pathname.match(/\.[a-z0-9]{1,8}$/i)?.[0]?.toLowerCase() ?? ".bin";
	const key = geoObjectKey(ctx.run.organizationId, "site", ctx.source.id, "asset", `${hash}${extension}`);
	await ctx.deps.objectStore.put(key, result.body, { contentType: result.mimeType ?? "application/octet-stream" });
	const now = nowOf(ctx.deps);
	const { page } = await upsertPage(ctx, result.finalUrl, {
		status: "ACTIVE",
		httpStatus: result.status,
		lastSeenAt: now,
		consecutiveFailures: 0,
		category: "attachment",
	});
	const [version] = await ctx.deps.db
		.insert(geoSitePageVersions)
		.values({
			organizationId: ctx.run.organizationId,
			pageId: page.id,
			contentHash: hash,
			parserVersion: "asset",
			htmlObjectKey: key,
			title: decodeURIComponent(new URL(result.finalUrl).pathname.split("/").pop() ?? ""),
			parsed: { mimeType: result.mimeType, size: result.body.length },
			fetchedAt: now,
			parseStatus: "SKIPPED",
		})
		.onConflictDoNothing()
		.returning({ id: geoSitePageVersions.id });
	await finishItem(ctx, item, "DONE", version ? "ASSET_STORED" : "UNCHANGED", {
		attempts,
		httpStatus: result.status,
		durationMs: result.durationMs,
		pageId: page.id,
		contentHash: hash,
		rawObjectKey: key,
		fetchedAt: now,
		versionId: version?.id ?? null,
	});
}

async function processItem(ctx: CrawlContext, item: ItemRow): Promise<void> {
	if (!isAllowedByRobots(ctx.robots, pathAndQuery(item.url))) {
		await finishItem(ctx, item, "SKIPPED", "ROBOTS_DISALLOWED");
		return;
	}
	if (item.isAsset) {
		await handleAsset(ctx, item);
		return;
	}
	const { result, attempts } = await politeFetch(ctx, item.url, {
		maxBytes: LIMITS.htmlBytes,
		timeoutMs: LIMITS.fetchTimeoutMs,
		allowedMimeTypes: [...HTML_MIME_TYPES],
	});
	if (!result) {
		await requeue(ctx, item);
		return;
	}
	const redirected = result.redirects.length > 0;

	if (!result.ok) {
		const outcome = outcomeOfFailure(result.code);
		if (result.code === "REDIRECT_BLOCKED" || result.code === "ADDRESS_BLOCKED") {
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
		const pageStatus: GeoSitePageStatus | null =
			result.code === "REDIRECT_BLOCKED" || result.code === "ADDRESS_BLOCKED" ? "BLOCKED" : null;
		const pageId = await recordFailure(ctx, item.url, pageStatus, result.status ?? null);
		await finishItem(ctx, item, "FAILED", outcome, {
			attempts,
			durationMs: result.durationMs,
			httpStatus: result.status ?? null,
			detail: result.detail.slice(0, 500),
			pageId,
		});
		return;
	}

	if (redirected && result.finalUrl !== item.url) {
		const { page, previousStatus } = await upsertPage(ctx, item.url, {
			status: "REDIRECTED",
			httpStatus: result.redirects[0].status,
			canonicalUrl: result.finalUrl,
			lastSeenAt: nowOf(ctx.deps),
		});
		if (previousStatus === "ACTIVE") await markPageUnavailable(ctx.deps.db, ctx.system, page, "REDIRECTED");
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
				url: result.finalUrl,
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
		if (!target) return;
		item = target;
	}

	const kind = classifyStatus(result.status);
	const common = { attempts, durationMs: result.durationMs, httpStatus: result.status };
	if (kind.kind === "OK") {
		await handleHtml(ctx, item, result, attempts);
		return;
	}
	if (kind.kind === "GONE") {
		const { page, previousStatus } = await upsertPage(ctx, item.url, { status: "GONE", httpStatus: result.status });
		if (previousStatus === "ACTIVE" || previousStatus === "ERROR") {
			await markPageUnavailable(ctx.deps.db, ctx.system, page, "GONE");
		}
		await finishItem(ctx, item, "DONE", "GONE", { ...common, pageId: page.id });
		return;
	}
	if (kind.kind === "AUTH_REQUIRED") {
		const pageId = await recordFailure(ctx, item.url, "BLOCKED", result.status);
		await finishItem(ctx, item, "FAILED", "AUTH_REQUIRED", {
			...common,
			pageId,
			detail: "需要鉴权，不尝试登录或绕过",
		});
		return;
	}
	const outcome: GeoCrawlItemOutcome = kind.kind === "RETRYABLE" ? kind.outcome : "CLIENT_ERROR";
	const pageId = await recordFailure(ctx, item.url, kind.kind === "CLIENT_ERROR" ? "ERROR" : null, result.status);
	await finishItem(ctx, item, "FAILED", outcome, { ...common, pageId, detail: `HTTP ${result.status}` });
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

/** A pause ends the chunk; a tripped breaker ends the run; a host busy with another run tries again shortly. */
async function stopEarly(ctx: CrawlContext, processed: number): Promise<CrawlChunkResult> {
	const { deps, run } = ctx;
	if (ctx.stop.reason === "PAUSED") return { status: "PAUSED", continued: false, processed };
	if (ctx.stop.reason === "BREAKER") {
		ctx.meta.breakerOpenUntil = ctx.stop.breakerUntil?.toISOString() ?? null;
		await saveMeta(ctx);
		return finalizeCrawlRun(deps, run.id, {
			forcedStatus: "PARTIAL",
			errorSummary: `源站连续失败触发熔断，${ctx.stop.breakerUntil?.toISOString() ?? ""} 前不再请求`,
		});
	}
	await deps.send(
		GEO_QUEUE.siteCrawl,
		{ organizationId: run.organizationId, runId: run.id },
		{ ...crawlJobOptions(run.id), startAfter: new Date(Date.now() + 30_000) },
	);
	return { status: "RUNNING", continued: true, processed };
}

export interface CrawlChunkResult {
	status: GeoCrawlStatus;
	continued: boolean;
	processed: number;
}

/**
 * One slice of a crawl run. It works through the frontier until the time slice
 * is used up, then sends itself again; pausing, the operating window, the page
 * budget and the circuit breaker are all checked between pages, and everything
 * needed to resume lives in the database rather than in this process.
 */
export async function processCrawlRun(
	deps: SiteJobDeps,
	input: { organizationId: string; runId: string },
): Promise<CrawlChunkResult> {
	let run = await loadCrawlRun(deps.db, input.organizationId, input.runId);
	if (run.status !== "QUEUED" && run.status !== "RUNNING") return { status: run.status, continued: false, processed: 0 };
	const [source] = await deps.db.select().from(geoSiteSources).where(eq(geoSiteSources.id, run.siteSourceId)).limit(1);
	const config = runConfigOf(run);
	if (!source?.enabled) {
		await deps.db
			.update(geoSiteCrawlRuns)
			.set({ status: "PAUSED", errorSummary: "站点采集已暂停" })
			.where(eq(geoSiteCrawlRuns.id, run.id));
		return { status: "PAUSED", continued: false, processed: 0 };
	}
	const profile = await loadProfileVersion(deps.db, run.organizationId, source.id, config.profileVersion).catch(() =>
		profileOfSource(source),
	);
	const meta = metaOf(run);
	const now = nowOf(deps);
	const window = parseOpWindow(source.opWindow);
	if (!isWithinWindow(window, now) && window) {
		const resumeAt = nextWindowStart(window, now);
		meta.resumeAt = resumeAt.toISOString();
		await deps.db
			.update(geoSiteCrawlRuns)
			.set({
				status: "QUEUED",
				counts: sql`jsonb_set(${geoSiteCrawlRuns.counts}, '{meta}', ${JSON.stringify(meta)}::jsonb, true)`,
			})
			.where(eq(geoSiteCrawlRuns.id, run.id));
		await deps.send(
			GEO_QUEUE.siteCrawl,
			{ organizationId: run.organizationId, runId: run.id },
			{ ...crawlJobOptions(run.id), startAfter: resumeAt },
		);
		return { status: "QUEUED", continued: true, processed: 0 };
	}

	const [started] = await deps.db
		.update(geoSiteCrawlRuns)
		.set({ status: "RUNNING", startedAt: sql`coalesce(${geoSiteCrawlRuns.startedAt}, now())` })
		.where(and(eq(geoSiteCrawlRuns.id, run.id), inArray(geoSiteCrawlRuns.status, ["QUEUED", "RUNNING"])))
		.returning();
	if (!started) return { status: run.status, continued: false, processed: 0 };
	run = started;
	meta.resumeAt = null;

	const ctx: CrawlContext = {
		deps,
		run,
		config,
		source,
		profile,
		robots: robotsFromStatus(404),
		meta,
		system: geoSystemPrincipal(run.organizationId, "site-crawl", `crawl-${run.id}`),
		interval: 0,
		userAgent: userAgentOf(source.userAgentContact),
		fetch: deps.fetch ?? safeFetch,
		sleep: deps.sleep ?? defaultSleep,
		stop: { reason: null },
	};
	ctx.interval = minIntervalMs(source.requestsPerSecond, null);

	await deps.db
		.update(geoSiteCrawlItems)
		.set({ status: "QUEUED" })
		.where(
			and(
				eq(geoSiteCrawlItems.runId, run.id),
				eq(geoSiteCrawlItems.status, "FETCHING"),
				lt(geoSiteCrawlItems.updatedAt, sql`now() - interval '10 minutes'`),
			),
		);

	if (meta.robots) {
		ctx.robots = { ...meta.robots, sitemaps: meta.robots.sitemaps };
	} else {
		const robots = await loadRobots(ctx);
		if (ctx.stop.reason) return stopEarly(ctx, 0);
		if (robots.source === "UNAVAILABLE") {
			meta.robots = { ...robots, sitemaps: [], rules: robots.rules };
			await saveMeta(ctx);
			return finalizeCrawlRun(deps, ctx.run.id, {
				forcedStatus: "FAILED",
				errorSummary: "robots.txt 无法获取（5xx 或网络错误），按 RFC 9309 暂不采集全站",
			});
		}
		ctx.robots = robots;
		await initializeFrontier(ctx);
		if (ctx.stop.reason) return stopEarly(ctx, 0);
		meta.robots = {
			source: robots.source,
			httpStatus: robots.httpStatus,
			crawlDelaySeconds: robots.crawlDelaySeconds,
			sitemaps: robots.sitemaps.slice(0, 20),
			rules: robots.rules.slice(0, 500),
		};
		await saveMeta(ctx);
	}
	ctx.interval = minIntervalMs(source.requestsPerSecond, ctx.robots.crawlDelaySeconds);

	const deadline = Date.now() + LIMITS.chunkMs;
	let processed = 0;
	while (!ctx.stop.reason && Date.now() < deadline) {
		if ((await currentStatus(ctx)) !== "RUNNING") {
			ctx.stop = { reason: "PAUSED" };
			break;
		}
		if ((await fetchedPageCount(ctx)) >= config.maxPages) {
			await deps.db
				.update(geoSiteCrawlItems)
				.set({ status: "SKIPPED", outcome: "BUDGET_EXCEEDED" })
				.where(and(eq(geoSiteCrawlItems.runId, run.id), eq(geoSiteCrawlItems.status, "QUEUED")));
			break;
		}
		if (window && !isWithinWindow(window, nowOf(deps))) break;
		const item = await claimNextItem(ctx);
		if (!item) break;
		await processItem(ctx, item);
		processed++;
	}
	await saveMeta(ctx);
	if (ctx.stop.reason) return stopEarly(ctx, processed);

	const [{ value: queued }] = await deps.db
		.select({ value: count() })
		.from(geoSiteCrawlItems)
		.where(and(eq(geoSiteCrawlItems.runId, run.id), eq(geoSiteCrawlItems.status, "QUEUED")));
	if (queued > 0) {
		await deps.send(GEO_QUEUE.siteCrawl, { organizationId: run.organizationId, runId: run.id }, crawlJobOptions(run.id));
		return { status: "RUNNING", continued: true, processed };
	}
	return finalizeCrawlRun(deps, run.id, {});
}
