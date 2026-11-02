import { randomUUID } from "node:crypto";
import {
	assertGeoPermission,
	GEO_CRAWL_MODES,
	GEO_PARSE_STATUSES,
	GEO_QUEUE,
	GEO_SITE_PAGE_STATUSES,
	GEO_SITE_QA_VERDICTS,
	GeoError,
	type GeoPrincipal,
	type GeoSiteQaVerdict,
} from "@workspace/geo-domain";
import { getObjectStore } from "@workspace/geo-evidence";
import {
	accuracyByField,
	accuracyOf,
	decodeStoredHtml,
	diffLines,
	drawSample,
	type ParsedPage,
	QA_CORE_FIELDS,
	type SiteOpWindow,
	sampleSizeFor,
	truncate,
} from "@workspace/geo-site-ingestion";
import { renderSnapshotForViewing } from "@workspace/geo-site-ingestion/snapshot";
import {
	auditRefusedUrls,
	type CrawlRunMeta,
	type CrawlRunSummary,
	createCrawlRun,
	createSiteSource,
	enqueueCrawlRun,
	failedUrlsOf,
	keyUrlCoverageOf,
	listProfileVersions,
	loadCrawlRun,
	loadParsedPage,
	loadSiteSource,
	type ParsedSummary,
	profileOfSource,
	runConfigOf,
	type SendJob,
	SiteUrlRefusedError,
	setCrawlRunPaused,
	siteMetrics,
	summarizeCrawlRun,
	updateSiteSource,
} from "@workspace/geo-site-ingestion/store";
import { db } from "@workspace/lib/db/db";
import {
	geoAlerts,
	geoAssertionSources,
	geoKnowledgeAssertions,
	geoSiteCrawlItems,
	geoSiteCrawlRuns,
	geoSiteEntities,
	geoSiteEntitySources,
	geoSitePages,
	geoSitePageVersions,
	geoSiteProfileVersions,
	geoSiteQaItems,
	geoSiteQaSamples,
	geoSiteSources,
} from "@workspace/lib/db/schema";
import { writeGeoAudit } from "@workspace/lib/geo/audit";
import { and, asc, count, desc, eq, getTableName, ilike, inArray, isNull, ne, or, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import { enqueueGeoJob } from "@/lib/geo/enqueue";

const send: SendJob = (queue, data, options) => enqueueGeoJob(queue, data, options);

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

export interface Paging {
	page: number;
	limit: number;
	offset: number;
}

async function withRefusalAudit<T>(
	principal: GeoPrincipal,
	action: string,
	siteSourceId: string | undefined,
	run: () => Promise<T>,
) {
	try {
		return await run();
	} catch (error) {
		if (error instanceof SiteUrlRefusedError) {
			await auditRefusedUrls(db, principal, error.refused, { siteSourceId, action });
		}
		throw error;
	}
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

export const siteSourceCreateSchema = z.object({}).passthrough();
export const siteSourcePatchSchema = z
	.object({
		baseUrl: z.string().optional(),
		allowedHosts: z.array(z.string()).optional(),
		seedUrls: z.array(z.string()).optional(),
		keyUrls: z.array(z.string()).optional(),
		profile: z.unknown().optional(),
		requestsPerSecond: z.number().optional(),
		maxPages: z.number().int().optional(),
		maxAssetBytes: z.number().int().optional(),
		opWindow: z.unknown().optional(),
		crawlCron: z.string().nullable().optional(),
		userAgentContact: z.string().nullable().optional(),
		authorizationNote: z.string().nullable().optional(),
		enabled: z.boolean().optional(),
	})
	.strict();
export type SiteSourcePatch = z.infer<typeof siteSourcePatchSchema>;

type SourceRow = typeof geoSiteSources.$inferSelect;

function sourceView(source: SourceRow) {
	const profile = profileOfSource(source);
	return {
		id: source.id,
		baseUrl: source.baseUrl,
		allowedHosts: source.allowedHosts,
		seedUrls: source.seedUrls,
		keyUrls: source.keyUrls,
		profile,
		profileVersion: profile.version,
		categories: profile.categories.map((category) => ({
			key: category.key,
			label: category.label,
			keySection: category.keySection,
			entityKind: category.entityKind ?? null,
		})),
		policyVersion: source.policyVersion,
		requestsPerSecond: source.requestsPerSecond,
		concurrency: source.concurrency,
		maxPages: source.maxPages,
		maxAssetBytes: source.maxAssetBytes,
		opWindow: (source.opWindow ?? null) as SiteOpWindow | null,
		crawlCron: source.crawlCron,
		userAgentContact: source.userAgentContact,
		authorizationNote: source.authorizationNote,
		enabled: source.enabled,
		lastSuccessAt: source.lastSuccessAt,
		createdAt: source.createdAt,
		updatedAt: source.updatedAt,
	};
}
export type SiteSourceView = ReturnType<typeof sourceView>;

function runView(run: typeof geoSiteCrawlRuns.$inferSelect) {
	const counts = (run.counts ?? {}) as { summary?: unknown; meta?: unknown };
	return {
		id: run.id,
		siteSourceId: run.siteSourceId,
		mode: run.mode,
		status: run.status,
		config: runConfigOf(run),
		policyVersion: run.policyVersion,
		summary: (counts.summary ?? null) as CrawlRunSummary | null,
		meta: (counts.meta ?? null) as CrawlRunMeta | null,
		requestedBy: run.requestedBy,
		errorSummary: run.errorSummary,
		createdAt: run.createdAt,
		startedAt: run.startedAt,
		finishedAt: run.finishedAt,
	};
}
export type CrawlRunView = ReturnType<typeof runView>;

export async function listSites(principal: GeoPrincipal) {
	assertGeoPermission(principal, "site.read");
	const sources = await db
		.select()
		.from(geoSiteSources)
		.where(eq(geoSiteSources.organizationId, principal.organizationId))
		.orderBy(asc(geoSiteSources.createdAt));
	const runs = sources.length
		? await db
				.selectDistinctOn([geoSiteCrawlRuns.siteSourceId])
				.from(geoSiteCrawlRuns)
				.where(
					and(
						eq(geoSiteCrawlRuns.organizationId, principal.organizationId),
						inArray(
							geoSiteCrawlRuns.siteSourceId,
							sources.map((source) => source.id),
						),
					),
				)
				.orderBy(geoSiteCrawlRuns.siteSourceId, desc(geoSiteCrawlRuns.createdAt))
		: [];
	return sources.map((source) => ({
		...sourceView(source),
		latestRun: (() => {
			const run = runs.find((entry) => entry.siteSourceId === source.id);
			return run ? runView(run) : null;
		})(),
	}));
}

export async function getSite(principal: GeoPrincipal, siteId: string) {
	assertGeoPermission(principal, "site.read");
	const source = await loadSiteSource(db, principal.organizationId, siteId);
	const [metrics, profileVersions, alerts] = await Promise.all([
		siteMetrics(db, principal.organizationId, source),
		listProfileVersions(db, principal.organizationId, source.id),
		db
			.select()
			.from(geoAlerts)
			.where(
				and(
					eq(geoAlerts.organizationId, principal.organizationId),
					ne(geoAlerts.status, "RESOLVED"),
					or(
						ilike(geoAlerts.dedupeKey, `%:${source.id}`),
						inArray(geoAlerts.dedupeKey, [
							"site-review-backlog",
							...source.allowedHosts.map((host) => `site-circuit-open:${host}`),
						]),
					),
				),
			)
			.orderBy(desc(geoAlerts.lastSeen)),
	]);
	return {
		source: sourceView(source),
		metrics,
		profileVersions,
		alerts: alerts.map((alert) => ({
			id: alert.id,
			kind: alert.kind,
			severity: alert.severity,
			status: alert.status,
			occurrences: alert.occurrences,
			firstSeen: alert.firstSeen,
			lastSeen: alert.lastSeen,
			context: alert.context as JsonObject,
		})),
	};
}

export async function createSite(principal: GeoPrincipal, input: unknown) {
	assertGeoPermission(principal, "site.manage");
	const source = await withRefusalAudit(principal, "site.create", undefined, () =>
		db.transaction((tx) => createSiteSource(tx, principal, input)),
	);
	return sourceView(source);
}

export async function updateSite(principal: GeoPrincipal, siteId: string, patch: SiteSourcePatch) {
	assertGeoPermission(principal, "site.manage");
	const source = await withRefusalAudit(principal, "site.update", siteId, () =>
		db.transaction((tx) => updateSiteSource(tx, principal, siteId, patch)),
	);
	return sourceView(source);
}

// ---------------------------------------------------------------------------
// Crawl runs
// ---------------------------------------------------------------------------

export const crawlRunCreateSchema = z.object({
	mode: z.enum(GEO_CRAWL_MODES).default("INCREMENTAL"),
	urls: z.array(z.string().min(1).max(2000)).max(500).optional(),
	maxPages: z.number().int().min(1).max(20_000).optional(),
});
export type CrawlRunCreateInput = z.infer<typeof crawlRunCreateSchema>;

/** Records the run, then enqueues it after commit; the job id is what the caller polls by. */
export async function startCrawl(
	principal: GeoPrincipal,
	siteId: string,
	input: CrawlRunCreateInput & { idempotencyKey?: string | null; followLinks?: boolean; retryOf?: string },
) {
	assertGeoPermission(principal, "site.crawl");
	const { run, created } = await withRefusalAudit(principal, "site.crawl.create", siteId, () =>
		db.transaction((tx) =>
			createCrawlRun(tx, principal, {
				siteSourceId: siteId,
				mode: input.mode,
				urls: input.urls,
				maxPages: input.maxPages,
				followLinks: input.followLinks,
				idempotencyKey: input.idempotencyKey ? `api:${input.idempotencyKey}` : null,
				trigger: input.retryOf ? "RETRY" : "MANUAL",
				retryOf: input.retryOf,
			}),
		),
	);
	const jobId = created || run.status === "QUEUED" ? await enqueueCrawlRun(send, run) : null;
	return { run: runView(run), created, jobId };
}

export async function listCrawlRuns(principal: GeoPrincipal, siteId: string, paging: Paging) {
	assertGeoPermission(principal, "site.read");
	await loadSiteSource(db, principal.organizationId, siteId);
	const where = and(
		eq(geoSiteCrawlRuns.organizationId, principal.organizationId),
		eq(geoSiteCrawlRuns.siteSourceId, siteId),
	);
	const [rows, [{ value: total }]] = await Promise.all([
		db
			.select()
			.from(geoSiteCrawlRuns)
			.where(where)
			.orderBy(desc(geoSiteCrawlRuns.createdAt))
			.limit(paging.limit)
			.offset(paging.offset),
		db.select({ value: count() }).from(geoSiteCrawlRuns).where(where),
	]);
	return { rows: rows.map(runView), total };
}

export async function getCrawlRun(principal: GeoPrincipal, siteId: string, runId: string) {
	assertGeoPermission(principal, "site.read");
	const run = await loadCrawlRun(db, principal.organizationId, runId);
	if (run.siteSourceId !== siteId) throw new GeoError("NOT_FOUND", "采集任务不存在");
	const [progress, problems] = await Promise.all([
		summarizeCrawlRun(db, run.id),
		db
			.select({
				id: geoSiteCrawlItems.id,
				url: geoSiteCrawlItems.url,
				status: geoSiteCrawlItems.status,
				outcome: geoSiteCrawlItems.outcome,
				httpStatus: geoSiteCrawlItems.httpStatus,
				attempts: geoSiteCrawlItems.attempts,
				detail: geoSiteCrawlItems.detail,
				pageId: geoSiteCrawlItems.pageId,
			})
			.from(geoSiteCrawlItems)
			.where(
				and(
					eq(geoSiteCrawlItems.runId, run.id),
					or(
						eq(geoSiteCrawlItems.status, "FAILED"),
						inArray(geoSiteCrawlItems.outcome, ["GONE", "REDIRECTED", "ROBOTS_DISALLOWED", "ASSET_RECORDED"]),
					),
				),
			)
			.orderBy(asc(geoSiteCrawlItems.status), asc(geoSiteCrawlItems.url))
			.limit(200),
	]);
	return { run: runView(run), progress, items: problems };
}

export async function setRunPaused(principal: GeoPrincipal, siteId: string, runId: string, paused: boolean) {
	assertGeoPermission(principal, "site.crawl");
	const existing = await loadCrawlRun(db, principal.organizationId, runId);
	if (existing.siteSourceId !== siteId) throw new GeoError("NOT_FOUND", "采集任务不存在");
	const run = await db.transaction((tx) => setCrawlRunPaused(tx, principal, runId, paused));
	const jobId = paused ? null : await enqueueCrawlRun(send, run);
	return { run: runView(run), jobId };
}

export async function retryFailedUrls(principal: GeoPrincipal, siteId: string, runId: string) {
	assertGeoPermission(principal, "site.crawl");
	const run = await loadCrawlRun(db, principal.organizationId, runId);
	if (run.siteSourceId !== siteId) throw new GeoError("NOT_FOUND", "采集任务不存在");
	const urls = await failedUrlsOf(db, principal.organizationId, runId);
	if (urls.length === 0) throw new GeoError("VALIDATION_ERROR", "该任务没有失败的网址");
	return startCrawl(principal, siteId, { mode: "INCREMENTAL", urls, followLinks: false, retryOf: runId });
}

// ---------------------------------------------------------------------------
// Pages and versions
// ---------------------------------------------------------------------------

export const sitePageFilterSchema = z.object({
	siteId: z.string().uuid().optional(),
	category: z.string().max(60).optional(),
	status: z.enum(GEO_SITE_PAGE_STATUSES).optional(),
	parseStatus: z.enum(GEO_PARSE_STATUSES).optional(),
	q: z.string().max(200).optional(),
	hasError: z.union([z.boolean(), z.enum(["true", "false"]).transform((value) => value === "true")]).optional(),
	reviewStatus: z.enum(["PENDING_REVIEW", "APPROVED", "NONE"]).optional(),
	seenAfter: z.string().datetime({ offset: true }).optional(),
	seenBefore: z.string().datetime({ offset: true }).optional(),
});
export type SitePageFilters = z.infer<typeof sitePageFilterSchema>;

/**
 * The outer page id, spelled out: drizzle drops table names from columns in a
 * single-table selection, and a bare "id" inside a subquery means the subquery's own.
 */
const outerPageId = sql`${sql.identifier(getTableName(geoSitePages))}.${sql.identifier(geoSitePages.id.name)}`;

/** A column of the page's newest version, newest by fetch time and then by parse time. */
function latest(column: "id" | "title" | "parse_status" | "parser_version") {
	return sql`(select v.${sql.raw(column)} from ${geoSitePageVersions} v
		where v.page_id = ${outerPageId} order by v.fetched_at desc, v.created_at desc limit 1)`;
}

function assertionExists(status: "PENDING_REVIEW" | "APPROVED") {
	return sql`exists (
		select 1 from ${geoAssertionSources} s
		join ${geoSitePageVersions} v on v.id = s.page_version_id
		join ${geoKnowledgeAssertions} a on a.id = s.assertion_id
		where v.page_id = ${geoSitePages.id} and a.status = ${status})`;
}

export async function listSitePages(principal: GeoPrincipal, filters: SitePageFilters, paging: Paging) {
	assertGeoPermission(principal, "site.read");
	const conditions: SQL[] = [eq(geoSitePages.organizationId, principal.organizationId)];
	if (filters.siteId) conditions.push(eq(geoSitePages.siteSourceId, filters.siteId));
	if (filters.category) {
		conditions.push(
			filters.category === "uncategorized"
				? isNull(geoSitePages.category)
				: eq(geoSitePages.category, filters.category),
		);
	}
	if (filters.status) conditions.push(eq(geoSitePages.status, filters.status));
	if (filters.q) conditions.push(ilike(geoSitePages.normalizedUrl, `%${filters.q.replace(/[%_\\]/g, "\\$&")}%`));
	if (filters.hasError) {
		conditions.push(
			sql`(${geoSitePages.status} in ('ERROR', 'GONE', 'BLOCKED') or ${latest("parse_status")} = 'FAILED')`,
		);
	}
	if (filters.parseStatus) conditions.push(sql`${latest("parse_status")} = ${filters.parseStatus}`);
	if (filters.reviewStatus === "PENDING_REVIEW") conditions.push(assertionExists("PENDING_REVIEW"));
	if (filters.reviewStatus === "APPROVED") conditions.push(assertionExists("APPROVED"));
	if (filters.reviewStatus === "NONE") {
		conditions.push(sql`not exists (
			select 1 from ${geoAssertionSources} s join ${geoSitePageVersions} v on v.id = s.page_version_id
			where v.page_id = ${geoSitePages.id})`);
	}
	if (filters.seenAfter) conditions.push(sql`${geoSitePages.lastSeenAt} >= ${filters.seenAfter}::timestamptz`);
	if (filters.seenBefore) conditions.push(sql`${geoSitePages.lastSeenAt} < ${filters.seenBefore}::timestamptz`);
	const where = and(...conditions);

	const [rows, [{ value: total }]] = await Promise.all([
		db
			.select({
				id: geoSitePages.id,
				siteSourceId: geoSitePages.siteSourceId,
				url: geoSitePages.normalizedUrl,
				canonicalUrl: geoSitePages.canonicalUrl,
				category: geoSitePages.category,
				status: geoSitePages.status,
				httpStatus: geoSitePages.httpStatus,
				lastSeenAt: geoSitePages.lastSeenAt,
				lastFetchedAt: geoSitePages.lastFetchedAt,
				consecutiveFailures: geoSitePages.consecutiveFailures,
				latestVersionId: sql<string | null>`${latest("id")}`,
				title: sql<string | null>`${latest("title")}`,
				parseStatus: sql<string | null>`${latest("parse_status")}`,
				parserVersion: sql<string | null>`${latest("parser_version")}`,
				versionCount: sql<number>`(select count(*)::int from ${geoSitePageVersions} v where v.page_id = ${outerPageId})`,
			})
			.from(geoSitePages)
			.where(where)
			.orderBy(asc(geoSitePages.normalizedUrl))
			.limit(paging.limit)
			.offset(paging.offset),
		db.select({ value: count() }).from(geoSitePages).where(where),
	]);
	return { rows, total };
}
export type SitePageRow = Awaited<ReturnType<typeof listSitePages>>["rows"][number];

async function loadPage(principal: GeoPrincipal, pageId: string) {
	const [page] = await db
		.select()
		.from(geoSitePages)
		.where(and(eq(geoSitePages.organizationId, principal.organizationId), eq(geoSitePages.id, pageId)))
		.limit(1);
	if (!page) throw new GeoError("NOT_FOUND", "页面不存在");
	return page;
}

function versionView(version: typeof geoSitePageVersions.$inferSelect) {
	return {
		id: version.id,
		contentHash: version.contentHash,
		parserVersion: version.parserVersion,
		title: version.title,
		parseStatus: version.parseStatus,
		errorCode: version.errorCode,
		fetchedAt: version.fetchedAt,
		createdAt: version.createdAt,
		parsed: version.parsed as ParsedSummary | null,
	};
}
export type SitePageVersionView = ReturnType<typeof versionView>;

export async function getSitePage(principal: GeoPrincipal, pageId: string) {
	assertGeoPermission(principal, "site.read");
	const page = await loadPage(principal, pageId);
	const [versions, entities, assertions, profileVersions] = await Promise.all([
		db
			.select()
			.from(geoSitePageVersions)
			.where(eq(geoSitePageVersions.pageId, page.id))
			.orderBy(desc(geoSitePageVersions.fetchedAt), desc(geoSitePageVersions.createdAt)),
		db
			.selectDistinct({
				id: geoSiteEntities.id,
				kind: geoSiteEntities.kind,
				title: geoSiteEntities.title,
				status: geoSiteEntities.status,
			})
			.from(geoSiteEntitySources)
			.innerJoin(geoSiteEntities, eq(geoSiteEntities.id, geoSiteEntitySources.entityId))
			.innerJoin(geoSitePageVersions, eq(geoSitePageVersions.id, geoSiteEntitySources.pageVersionId))
			.where(eq(geoSitePageVersions.pageId, page.id)),
		db
			.selectDistinct({
				id: geoKnowledgeAssertions.id,
				fieldPath: geoKnowledgeAssertions.fieldPath,
				claimType: geoKnowledgeAssertions.claimType,
				claimText: geoKnowledgeAssertions.claimText,
				status: geoKnowledgeAssertions.status,
				riskLevel: geoKnowledgeAssertions.riskLevel,
				pageVersionId: geoAssertionSources.pageVersionId,
			})
			.from(geoAssertionSources)
			.innerJoin(geoKnowledgeAssertions, eq(geoKnowledgeAssertions.id, geoAssertionSources.assertionId))
			.innerJoin(geoSitePageVersions, eq(geoSitePageVersions.id, geoAssertionSources.pageVersionId))
			.where(eq(geoSitePageVersions.pageId, page.id)),
		db
			.select({ version: geoSiteProfileVersions.version, createdAt: geoSiteProfileVersions.createdAt })
			.from(geoSiteProfileVersions)
			.where(eq(geoSiteProfileVersions.siteSourceId, page.siteSourceId))
			.orderBy(desc(geoSiteProfileVersions.version)),
	]);
	return {
		page: {
			id: page.id,
			siteSourceId: page.siteSourceId,
			url: page.normalizedUrl,
			canonicalUrl: page.canonicalUrl,
			category: page.category,
			status: page.status,
			httpStatus: page.httpStatus,
			lastSeenAt: page.lastSeenAt,
			lastFetchedAt: page.lastFetchedAt,
			consecutiveFailures: page.consecutiveFailures,
			createdAt: page.createdAt,
		},
		versions: versions.map(versionView),
		entities,
		assertions,
		profileVersions,
	};
}

export async function listPageVersions(principal: GeoPrincipal, pageId: string) {
	const detail = await getSitePage(principal, pageId);
	return detail.versions;
}

/**
 * One version with its full parse, and a line diff of its text against the
 * version given in `compareTo`, or the previous distinct content otherwise.
 */
export async function getPageVersion(
	principal: GeoPrincipal,
	pageId: string,
	versionId: string,
	compareTo?: string | null,
) {
	assertGeoPermission(principal, "site.read");
	const page = await loadPage(principal, pageId);
	const versions = await db
		.select()
		.from(geoSitePageVersions)
		.where(eq(geoSitePageVersions.pageId, page.id))
		.orderBy(desc(geoSitePageVersions.fetchedAt), desc(geoSitePageVersions.createdAt));
	const version = versions.find((entry) => entry.id === versionId);
	if (!version) throw new GeoError("NOT_FOUND", "页面版本不存在");
	const store = getObjectStore();
	const parsed = await loadParsedPage({ objectStore: store }, version);
	const baseline = compareTo
		? versions.find((entry) => entry.id === compareTo)
		: versions.find(
				(entry) =>
					entry.contentHash !== version.contentHash &&
					entry.fetchedAt.getTime() <= version.fetchedAt.getTime() &&
					entry.parseStatus === "PARSED",
			);
	const baselineParsed = baseline ? await loadParsedPage({ objectStore: store }, baseline) : null;
	const diff = baselineParsed && parsed ? diffLines(baselineParsed.text, parsed.text) : null;
	return {
		version: versionView(version),
		parsed: parsed ? trimParsed(parsed) : null,
		compareTo: baseline ? versionView(baseline) : null,
		diff,
	};
}

function trimParsed(page: ParsedPage) {
	return {
		...page,
		text: truncate(page.text, 50_000),
		tables: page.tables.slice(0, 20),
		images: page.images.slice(0, 100),
	};
}

async function loadVersionForSnapshot(principal: GeoPrincipal, versionId: string) {
	assertGeoPermission(principal, "site.read_snapshot");
	const [row] = await db
		.select({ version: geoSitePageVersions, url: geoSitePages.normalizedUrl })
		.from(geoSitePageVersions)
		.innerJoin(geoSitePages, eq(geoSitePages.id, geoSitePageVersions.pageId))
		.where(and(eq(geoSitePageVersions.organizationId, principal.organizationId), eq(geoSitePageVersions.id, versionId)))
		.limit(1);
	if (!row) throw new GeoError("NOT_FOUND", "页面版本不存在");
	const object = await getObjectStore().get(row.version.htmlObjectKey);
	if (!object) throw new GeoError("NOT_FOUND", "原始快照不存在");
	return { ...row, object };
}

/** Sanitized HTML for `<iframe sandbox srcdoc>`; never the raw page. */
export async function getSnapshotForViewing(principal: GeoPrincipal, versionId: string) {
	const { version, url, object } = await loadVersionForSnapshot(principal, versionId);
	if (version.parseStatus === "SKIPPED") {
		return { url, fetchedAt: version.fetchedAt, html: null, contentType: object.contentType };
	}
	const text = decodeStoredHtml(object.body, object.contentType);
	await writeGeoAudit(db, {
		principal,
		action: "site.snapshot.view",
		entityType: "site_page_version",
		entityId: version.id,
	});
	return { url, fetchedAt: version.fetchedAt, html: renderSnapshotForViewing(text), contentType: object.contentType };
}

/**
 * The stored bytes as a download. Served as an attachment of an inert type so a
 * browser never renders captured markup on this origin.
 */
export async function getSnapshotDownload(principal: GeoPrincipal, versionId: string): Promise<Response> {
	const { version, object } = await loadVersionForSnapshot(principal, versionId);
	await writeGeoAudit(db, {
		principal,
		action: "site.snapshot.download",
		entityType: "site_page_version",
		entityId: version.id,
		metadata: { size: object.size },
	});
	const isHtml = version.parseStatus !== "SKIPPED";
	const extension = isHtml ? "html" : (version.htmlObjectKey.split(".").pop() ?? "bin");
	return new Response(new Uint8Array(object.body), {
		headers: {
			"Content-Type": isHtml ? "text/plain; charset=utf-8" : "application/octet-stream",
			"Content-Disposition": `attachment; filename="snapshot-${version.id}.${extension}"`,
			"Content-Security-Policy": "sandbox; default-src 'none'",
			"X-Content-Type-Options": "nosniff",
			"Cache-Control": "private, no-store",
		},
	});
}

export const reparseSchema = z.object({
	versionId: z.string().uuid().nullable().optional(),
	profileVersion: z.number().int().min(1).nullable().optional(),
});
export type ReparseInput = z.infer<typeof reparseSchema>;

/** Queues a re-parse of stored HTML; nothing is downloaded again. */
export async function requestReparse(principal: GeoPrincipal, pageId: string, input: ReparseInput) {
	assertGeoPermission(principal, "site.reparse");
	const page = await loadPage(principal, pageId);
	if (input.versionId) {
		const [version] = await db
			.select({ id: geoSitePageVersions.id })
			.from(geoSitePageVersions)
			.where(and(eq(geoSitePageVersions.pageId, page.id), eq(geoSitePageVersions.id, input.versionId)))
			.limit(1);
		if (!version) throw new GeoError("NOT_FOUND", "页面版本不存在");
	} else {
		const [any] = await db
			.select({ id: geoSitePageVersions.id })
			.from(geoSitePageVersions)
			.where(eq(geoSitePageVersions.pageId, page.id))
			.limit(1);
		if (!any) throw new GeoError("VALIDATION_ERROR", "页面还没有可重新解析的版本");
	}
	if (input.profileVersion) {
		const [profile] = await db
			.select({ id: geoSiteProfileVersions.id })
			.from(geoSiteProfileVersions)
			.where(
				and(
					eq(geoSiteProfileVersions.siteSourceId, page.siteSourceId),
					eq(geoSiteProfileVersions.version, input.profileVersion),
				),
			)
			.limit(1);
		if (!profile) throw new GeoError("NOT_FOUND", `解析配置版本 ${input.profileVersion} 不存在`);
	}
	const reparse = { pageId: page.id, versionId: input.versionId ?? null, profileVersion: input.profileVersion ?? null };
	const jobId = await enqueueGeoJob(
		GEO_QUEUE.siteParse,
		{ organizationId: principal.organizationId, reparse },
		{ singletonKey: `reparse:${page.id}:${reparse.versionId ?? "latest"}:${reparse.profileVersion ?? "current"}` },
	);
	await writeGeoAudit(db, {
		principal,
		action: "site.reparse.request",
		entityType: "site_page",
		entityId: page.id,
		metadata: { ...reparse, jobId },
	});
	return { jobId, ...reparse };
}

export async function refetchPage(principal: GeoPrincipal, pageId: string) {
	const page = await loadPage(principal, pageId);
	return startCrawl(principal, page.siteSourceId, {
		mode: "INCREMENTAL",
		urls: [page.normalizedUrl],
		followLinks: false,
	});
}

// ---------------------------------------------------------------------------
// Key URL coverage and quality sampling
// ---------------------------------------------------------------------------

export async function getKeyUrlCoverage(principal: GeoPrincipal, siteId: string) {
	assertGeoPermission(principal, "site.read");
	const source = await loadSiteSource(db, principal.organizationId, siteId);
	return keyUrlCoverageOf(db, principal.organizationId, source);
}

export async function setKeyUrls(principal: GeoPrincipal, siteId: string, urls: string[]) {
	return updateSite(principal, siteId, { keyUrls: urls });
}

function fieldValueText(value: unknown): string | null {
	if (value === null || value === undefined) return null;
	if (typeof value === "string") return truncate(value, 1000);
	if (Array.isArray(value)) {
		if (value.length === 0) return null;
		return truncate(value.map((entry) => (Array.isArray(entry) ? entry.join(" | ") : String(entry))).join("\n"), 1000);
	}
	return truncate(JSON.stringify(value), 1000);
}

export const qaSampleCreateSchema = z.object({ size: z.number().int().min(1).max(500).optional() });

/**
 * PRD 3.11 acceptance: at least 30 parsed pages drawn at random (all of them
 * when fewer), each labelled field by field. The seed is stored so the draw
 * can be reproduced.
 */
export async function createQaSample(principal: GeoPrincipal, siteId: string, size?: number) {
	assertGeoPermission(principal, "site.crawl");
	const source = await loadSiteSource(db, principal.organizationId, siteId);
	const profile = profileOfSource(source);
	const population = await db
		.selectDistinctOn([geoSitePageVersions.pageId], {
			id: geoSitePageVersions.id,
			pageId: geoSitePageVersions.pageId,
			parsed: geoSitePageVersions.parsed,
		})
		.from(geoSitePageVersions)
		.innerJoin(geoSitePages, eq(geoSitePages.id, geoSitePageVersions.pageId))
		.where(
			and(
				eq(geoSitePages.organizationId, principal.organizationId),
				eq(geoSitePages.siteSourceId, source.id),
				eq(geoSitePages.status, "ACTIVE"),
				eq(geoSitePageVersions.parseStatus, "PARSED"),
			),
		)
		.orderBy(geoSitePageVersions.pageId, desc(geoSitePageVersions.fetchedAt), desc(geoSitePageVersions.createdAt));
	if (population.length === 0) throw new GeoError("VALIDATION_ERROR", "还没有解析成功的页面可供抽检");
	const seed = randomUUID();
	const chosen = drawSample(population, sampleSizeFor(population.length, size), seed);

	return db.transaction(async (tx) => {
		const [sample] = await tx
			.insert(geoSiteQaSamples)
			.values({
				organizationId: principal.organizationId,
				siteSourceId: source.id,
				population: population.length,
				sampleSize: chosen.length,
				seed,
				createdBy: principal.actorId,
			})
			.returning();
		const items = chosen.flatMap((version) => {
			const parsed = (version.parsed ?? {}) as Partial<ParsedSummary>;
			const fieldValues = new Map((parsed.fields ?? []).map((field) => [field.path, field.value]));
			const core: Record<(typeof QA_CORE_FIELDS)[number], unknown> = {
				title: parsed.title,
				category: parsed.categoryLabel ?? parsed.category ?? "未分类",
				publishedAt: parsed.publishedAt,
				text: parsed.excerpt,
				images: parsed.images,
			};
			const extra = [...new Set([...profile.qaFields, ...fieldValues.keys()])].filter(
				(path) => !(QA_CORE_FIELDS as readonly string[]).includes(path),
			);
			return [
				...QA_CORE_FIELDS.map((path) => ({ path, value: core[path] })),
				...extra.map((path) => ({ path, value: fieldValues.get(path) })),
			].map(({ path, value }) => ({
				organizationId: principal.organizationId,
				sampleId: sample.id,
				pageVersionId: version.id,
				fieldPath: path,
				extractedValue: fieldValueText(value),
			}));
		});
		for (let index = 0; index < items.length; index += 500) {
			await tx.insert(geoSiteQaItems).values(items.slice(index, index + 500));
		}
		await writeGeoAudit(tx, {
			principal,
			action: "site.qa.create",
			entityType: "site_qa_sample",
			entityId: sample.id,
			metadata: { siteSourceId: source.id, population: population.length, sampleSize: chosen.length, seed },
		});
		return sample;
	});
}

export async function listQaSamples(principal: GeoPrincipal, siteId: string) {
	assertGeoPermission(principal, "site.read");
	const samples = await db
		.select()
		.from(geoSiteQaSamples)
		.where(
			and(eq(geoSiteQaSamples.organizationId, principal.organizationId), eq(geoSiteQaSamples.siteSourceId, siteId)),
		)
		.orderBy(desc(geoSiteQaSamples.createdAt))
		.limit(50);
	if (samples.length === 0) return [];
	const verdicts = await db
		.select({ sampleId: geoSiteQaItems.sampleId, verdict: geoSiteQaItems.verdict })
		.from(geoSiteQaItems)
		.where(
			inArray(
				geoSiteQaItems.sampleId,
				samples.map((sample) => sample.id),
			),
		);
	return samples.map((sample) => ({
		...sample,
		accuracy: accuracyOf(verdicts.filter((row) => row.sampleId === sample.id).map((row) => row.verdict)),
	}));
}

export async function getQaSample(principal: GeoPrincipal, sampleId: string) {
	assertGeoPermission(principal, "site.read");
	const [sample] = await db
		.select()
		.from(geoSiteQaSamples)
		.where(and(eq(geoSiteQaSamples.organizationId, principal.organizationId), eq(geoSiteQaSamples.id, sampleId)))
		.limit(1);
	if (!sample) throw new GeoError("NOT_FOUND", "抽检批次不存在");
	const items = await db
		.select({
			id: geoSiteQaItems.id,
			pageVersionId: geoSiteQaItems.pageVersionId,
			fieldPath: geoSiteQaItems.fieldPath,
			extractedValue: geoSiteQaItems.extractedValue,
			verdict: geoSiteQaItems.verdict,
			note: geoSiteQaItems.note,
			reviewerId: geoSiteQaItems.reviewerId,
			reviewedAt: geoSiteQaItems.reviewedAt,
			pageId: geoSitePages.id,
			url: geoSitePages.normalizedUrl,
			title: geoSitePageVersions.title,
		})
		.from(geoSiteQaItems)
		.innerJoin(geoSitePageVersions, eq(geoSitePageVersions.id, geoSiteQaItems.pageVersionId))
		.innerJoin(geoSitePages, eq(geoSitePages.id, geoSitePageVersions.pageId))
		.where(eq(geoSiteQaItems.sampleId, sample.id))
		.orderBy(asc(geoSitePages.normalizedUrl), asc(geoSiteQaItems.fieldPath));
	return {
		sample,
		items,
		accuracy: accuracyOf(items.map((item) => item.verdict)),
		byField: accuracyByField(items),
	};
}

export const qaLabelSchema = z.object({
	verdict: z.enum(GEO_SITE_QA_VERDICTS),
	note: z.string().max(1000).nullable().optional(),
});

export async function labelQaItem(
	principal: GeoPrincipal,
	itemId: string,
	input: { verdict: GeoSiteQaVerdict; note?: string | null },
) {
	assertGeoPermission(principal, "site.crawl");
	return db.transaction(async (tx) => {
		const [item] = await tx
			.update(geoSiteQaItems)
			.set({ verdict: input.verdict, note: input.note ?? null, reviewerId: principal.actorId, reviewedAt: sql`now()` })
			.where(and(eq(geoSiteQaItems.organizationId, principal.organizationId), eq(geoSiteQaItems.id, itemId)))
			.returning();
		if (!item) throw new GeoError("NOT_FOUND", "抽检条目不存在");
		const [{ value: pending }] = await tx
			.select({ value: count() })
			.from(geoSiteQaItems)
			.where(and(eq(geoSiteQaItems.sampleId, item.sampleId), isNull(geoSiteQaItems.verdict)));
		await tx
			.update(geoSiteQaSamples)
			.set(pending === 0 ? { status: "COMPLETED", completedAt: sql`now()` } : { status: "OPEN", completedAt: null })
			.where(eq(geoSiteQaSamples.id, item.sampleId));
		await writeGeoAudit(tx, {
			principal,
			action: "site.qa.label",
			entityType: "site_qa_item",
			entityId: item.id,
			after: { verdict: item.verdict },
			metadata: { sampleId: item.sampleId, fieldPath: item.fieldPath },
		});
		return item;
	});
}
