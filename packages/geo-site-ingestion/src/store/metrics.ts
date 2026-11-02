import type { DbConnection } from "@workspace/lib/db/db-connection";
import {
	geoAssertionSources,
	geoKnowledgeAssertions,
	geoSiteCrawlRuns,
	geoSiteHostThrottle,
	geoSitePages,
	geoSitePageVersions,
	type geoSiteSources,
} from "@workspace/lib/db/schema";
import { and, count, countDistinct, desc, eq, gte, inArray, ne, sql } from "drizzle-orm";
import { keyUrlCoverage } from "../qa";
import type { CrawlRunSummary } from "./finalize";

type SourceRow = typeof geoSiteSources.$inferSelect;

export interface KeyUrlStatus {
	url: string;
	pageId: string | null;
	status: string | null;
	parsed: boolean;
	lastSeenAt: Date | null;
}

export async function keyUrlStatuses(
	db: DbConnection,
	organizationId: string,
	source: Pick<SourceRow, "id" | "keyUrls">,
): Promise<KeyUrlStatus[]> {
	if (source.keyUrls.length === 0) return [];
	const rows = await db
		.select({
			url: geoSitePages.normalizedUrl,
			pageId: geoSitePages.id,
			status: geoSitePages.status,
			lastSeenAt: geoSitePages.lastSeenAt,
			parsed: sql<boolean>`exists (select 1 from ${geoSitePageVersions} v where v.page_id = ${geoSitePages.id} and v.parse_status = 'PARSED')`,
		})
		.from(geoSitePages)
		.where(
			and(
				eq(geoSitePages.organizationId, organizationId),
				eq(geoSitePages.siteSourceId, source.id),
				inArray(geoSitePages.normalizedUrl, source.keyUrls),
			),
		);
	const byUrl = new Map(rows.map((row) => [row.url, row]));
	return source.keyUrls.map((url) => {
		const row = byUrl.get(url);
		return {
			url,
			pageId: row?.pageId ?? null,
			status: row?.status ?? null,
			parsed: Boolean(row?.parsed),
			lastSeenAt: row?.lastSeenAt ?? null,
		};
	});
}

/** A key URL counts as covered only when it is live and has a parsed version. */
export async function keyUrlCoverageOf(
	db: DbConnection,
	organizationId: string,
	source: Pick<SourceRow, "id" | "keyUrls">,
) {
	const statuses = await keyUrlStatuses(db, organizationId, source);
	const covered = new Set(statuses.filter((entry) => entry.status === "ACTIVE" && entry.parsed).map((entry) => entry.url));
	return { ...keyUrlCoverage(source.keyUrls, covered), statuses };
}

export interface SiteMetrics {
	discoveredUrls: number;
	pagesByStatus: Record<string, number>;
	suspectedDeadPages: number;
	lastRun: {
		id: string;
		status: string;
		finishedAt: Date | null;
		successRate: number | null;
		unchangedRate: number | null;
		p95Ms: number | null;
		requests: number;
		observedRequestsPerSecond: number | null;
	} | null;
	parse: { versions: number; failed: number; failureRate: number | null };
	approvedEntitiesBySection: Record<string, number>;
	hosts: Array<{ host: string; consecutiveFailures: number; breakerOpenUntil: Date | null; lastSuccessAt: Date | null }>;
	lastSuccessAt: Date | null;
	configuredRequestsPerSecond: number;
	keyUrls: { total: number; covered: number; ratio: number | null; missing: string[] };
}

/** PRD 10.4: the numbers the site-ingestion acceptance and alerting are judged on. */
export async function siteMetrics(db: DbConnection, organizationId: string, source: SourceRow): Promise<SiteMetrics> {
	const statusRows = await db
		.select({ status: geoSitePages.status, pages: count() })
		.from(geoSitePages)
		.where(and(eq(geoSitePages.organizationId, organizationId), eq(geoSitePages.siteSourceId, source.id)))
		.groupBy(geoSitePages.status);
	const pagesByStatus = Object.fromEntries(statusRows.map((row) => [row.status, row.pages]));

	const [lastRun] = await db
		.select()
		.from(geoSiteCrawlRuns)
		.where(
			and(
				eq(geoSiteCrawlRuns.siteSourceId, source.id),
				inArray(geoSiteCrawlRuns.status, ["SUCCEEDED", "PARTIAL", "FAILED"]),
			),
		)
		.orderBy(desc(geoSiteCrawlRuns.finishedAt))
		.limit(1);
	const summary = (lastRun?.counts as { summary?: CrawlRunSummary } | undefined)?.summary;
	const seconds =
		lastRun?.startedAt && lastRun.finishedAt ? (lastRun.finishedAt.getTime() - lastRun.startedAt.getTime()) / 1000 : 0;

	const [parse] = await db
		.select({
			versions: count(),
			failed: sql<number>`count(*) filter (where ${geoSitePageVersions.parseStatus} = 'FAILED')::int`,
		})
		.from(geoSitePageVersions)
		.innerJoin(geoSitePages, eq(geoSitePages.id, geoSitePageVersions.pageId))
		.where(
			and(
				eq(geoSitePages.siteSourceId, source.id),
				ne(geoSitePageVersions.parseStatus, "SKIPPED"),
				gte(geoSitePageVersions.createdAt, sql`now() - interval '30 days'`),
			),
		);

	const approved = await db
		.select({ category: geoSitePages.category, entities: countDistinct(geoKnowledgeAssertions.entityId) })
		.from(geoKnowledgeAssertions)
		.innerJoin(geoAssertionSources, eq(geoAssertionSources.assertionId, geoKnowledgeAssertions.id))
		.innerJoin(geoSitePageVersions, eq(geoSitePageVersions.id, geoAssertionSources.pageVersionId))
		.innerJoin(geoSitePages, eq(geoSitePages.id, geoSitePageVersions.pageId))
		.where(
			and(
				eq(geoKnowledgeAssertions.organizationId, organizationId),
				eq(geoKnowledgeAssertions.status, "APPROVED"),
				eq(geoSitePages.siteSourceId, source.id),
			),
		)
		.groupBy(geoSitePages.category);

	const hosts = await db
		.select()
		.from(geoSiteHostThrottle)
		.where(inArray(geoSiteHostThrottle.host, source.allowedHosts));
	const coverage = await keyUrlCoverageOf(db, organizationId, source);

	return {
		discoveredUrls: statusRows.reduce((sum, row) => sum + row.pages, 0),
		pagesByStatus,
		suspectedDeadPages: (pagesByStatus.GONE ?? 0) + (pagesByStatus.ERROR ?? 0),
		lastRun: lastRun
			? {
					id: lastRun.id,
					status: lastRun.status,
					finishedAt: lastRun.finishedAt,
					successRate: summary?.successRate ?? null,
					unchangedRate: summary?.unchangedRate ?? null,
					p95Ms: summary?.p95Ms ?? null,
					requests: summary?.requests ?? 0,
					observedRequestsPerSecond: seconds > 0 && summary ? summary.requests / seconds : null,
				}
			: null,
		parse: {
			versions: parse?.versions ?? 0,
			failed: parse?.failed ?? 0,
			failureRate: parse && parse.versions > 0 ? parse.failed / parse.versions : null,
		},
		approvedEntitiesBySection: Object.fromEntries(approved.map((row) => [row.category ?? "uncategorized", row.entities])),
		hosts: hosts.map((host) => ({
			host: host.host,
			consecutiveFailures: host.consecutiveFailures,
			breakerOpenUntil: host.breakerOpenUntil,
			lastSuccessAt: host.lastSuccessAt,
		})),
		lastSuccessAt: source.lastSuccessAt,
		configuredRequestsPerSecond: source.requestsPerSecond,
		keyUrls: { total: coverage.total, covered: coverage.covered, ratio: coverage.ratio, missing: coverage.missing },
	};
}
