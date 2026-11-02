import { type GeoCrawlItemOutcome, type GeoCrawlStatus, geoSystemPrincipal } from "@workspace/geo-domain";
import type { DbConnection } from "@workspace/lib/db/db-connection";
import { geoSiteCrawlItems, geoSiteCrawlRuns, geoSitePages, geoSiteSources } from "@workspace/lib/db/schema";
import { raiseGeoAlert, resolveGeoAlert } from "@workspace/lib/geo/alerts";
import { writeGeoAudit } from "@workspace/lib/geo/audit";
import { and, count, desc, eq, inArray, ne, sql } from "drizzle-orm";
import type { SiteJobDeps } from "./deps";
import { keyUrlCoverageOf } from "./metrics";
import { loadProfileVersion, profileOfSource } from "./sources";

export const SUCCESS_OUTCOMES: GeoCrawlItemOutcome[] = ["NEW_VERSION", "UNCHANGED", "DUPLICATE"];

export interface CrawlRunSummary {
	total: number;
	queued: number;
	done: number;
	failed: number;
	skipped: number;
	outcomes: Partial<Record<GeoCrawlItemOutcome, number>>;
	requests: number;
	succeeded: number;
	newVersions: number;
	unchanged: number;
	duplicates: number;
	gone: number;
	status403: number;
	status429: number;
	p50Ms: number | null;
	p95Ms: number | null;
	successRate: number | null;
	unchangedRate: number | null;
	/** Pages fetched successfully per category, the basis for the section-drop alert. */
	sections: Record<string, number>;
}

export async function summarizeCrawlRun(db: DbConnection, runId: string): Promise<CrawlRunSummary> {
	const grouped = await db
		.select({
			status: geoSiteCrawlItems.status,
			outcome: geoSiteCrawlItems.outcome,
			items: count(),
			attempts: sql<number>`coalesce(sum(${geoSiteCrawlItems.attempts}), 0)::int`,
		})
		.from(geoSiteCrawlItems)
		.where(eq(geoSiteCrawlItems.runId, runId))
		.groupBy(geoSiteCrawlItems.status, geoSiteCrawlItems.outcome);
	const [timing] = await db
		.select({
			p50: sql<number | null>`percentile_cont(0.5) within group (order by ${geoSiteCrawlItems.durationMs})`,
			p95: sql<number | null>`percentile_cont(0.95) within group (order by ${geoSiteCrawlItems.durationMs})`,
			status403: sql<number>`count(*) filter (where ${geoSiteCrawlItems.httpStatus} = 403)::int`,
			status429: sql<number>`count(*) filter (where ${geoSiteCrawlItems.httpStatus} = 429)::int`,
		})
		.from(geoSiteCrawlItems)
		.where(and(eq(geoSiteCrawlItems.runId, runId), sql`${geoSiteCrawlItems.durationMs} is not null`));
	const sectionRows = await db
		.select({ category: geoSitePages.category, pages: count() })
		.from(geoSiteCrawlItems)
		.innerJoin(geoSitePages, eq(geoSitePages.id, geoSiteCrawlItems.pageId))
		.where(and(eq(geoSiteCrawlItems.runId, runId), inArray(geoSiteCrawlItems.outcome, SUCCESS_OUTCOMES)))
		.groupBy(geoSitePages.category);

	const summary: CrawlRunSummary = {
		total: 0,
		queued: 0,
		done: 0,
		failed: 0,
		skipped: 0,
		outcomes: {},
		requests: 0,
		succeeded: 0,
		newVersions: 0,
		unchanged: 0,
		duplicates: 0,
		gone: 0,
		status403: timing?.status403 ?? 0,
		status429: timing?.status429 ?? 0,
		p50Ms: timing?.p50 === null || timing?.p50 === undefined ? null : Math.round(Number(timing.p50)),
		p95Ms: timing?.p95 === null || timing?.p95 === undefined ? null : Math.round(Number(timing.p95)),
		successRate: null,
		unchangedRate: null,
		sections: Object.fromEntries(sectionRows.map((row) => [row.category ?? "uncategorized", row.pages])),
	};
	for (const row of grouped) {
		summary.total += row.items;
		summary.requests += Number(row.attempts);
		if (row.status === "QUEUED" || row.status === "FETCHING") summary.queued += row.items;
		if (row.status === "DONE") summary.done += row.items;
		if (row.status === "FAILED") summary.failed += row.items;
		if (row.status === "SKIPPED") summary.skipped += row.items;
		if (row.outcome) summary.outcomes[row.outcome] = (summary.outcomes[row.outcome] ?? 0) + row.items;
	}
	summary.newVersions = summary.outcomes.NEW_VERSION ?? 0;
	summary.unchanged = summary.outcomes.UNCHANGED ?? 0;
	summary.duplicates = summary.outcomes.DUPLICATE ?? 0;
	summary.gone = summary.outcomes.GONE ?? 0;
	summary.succeeded = summary.newVersions + summary.unchanged + summary.duplicates;
	const attempted = summary.succeeded + summary.failed + summary.gone;
	summary.successRate = attempted === 0 ? null : summary.succeeded / attempted;
	summary.unchangedRate = summary.succeeded === 0 ? null : summary.unchanged / summary.succeeded;
	return summary;
}

async function previousSections(db: DbConnection, sourceId: string, runId: string) {
	const [previous] = await db
		.select({ counts: geoSiteCrawlRuns.counts })
		.from(geoSiteCrawlRuns)
		.where(
			and(
				eq(geoSiteCrawlRuns.siteSourceId, sourceId),
				ne(geoSiteCrawlRuns.id, runId),
				inArray(geoSiteCrawlRuns.status, ["SUCCEEDED", "PARTIAL"]),
				sql`${geoSiteCrawlRuns.config}->'seedUrls' = 'null'::jsonb`,
			),
		)
		.orderBy(desc(geoSiteCrawlRuns.finishedAt))
		.limit(1);
	return ((previous?.counts as { summary?: CrawlRunSummary } | undefined)?.summary?.sections ?? null) as Record<
		string,
		number
	> | null;
}

/**
 * Closes a run: summary from its frontier, a final status, the source's last
 * success time, and the alerts PRD 10.4 asks for, raised or cleared.
 */
export async function finalizeCrawlRun(
	deps: SiteJobDeps,
	runId: string,
	options: { forcedStatus?: GeoCrawlStatus; errorSummary?: string },
) {
	const { db } = deps;
	const [run] = await db.select().from(geoSiteCrawlRuns).where(eq(geoSiteCrawlRuns.id, runId)).limit(1);
	const [source] = await db.select().from(geoSiteSources).where(eq(geoSiteSources.id, run.siteSourceId)).limit(1);
	const summary = await summarizeCrawlRun(db, runId);
	const budgetHit = (summary.outcomes.BUDGET_EXCEEDED ?? 0) > 0;
	const status: GeoCrawlStatus =
		options.forcedStatus ??
		(summary.succeeded === 0 && summary.gone === 0
			? "FAILED"
			: summary.failed > 0 || budgetHit
				? "PARTIAL"
				: "SUCCEEDED");
	const errorSummary =
		options.errorSummary ??
		(status === "FAILED"
			? "没有成功采集到任何页面"
			: budgetHit
				? "达到页面预算，剩余网址未采集"
				: summary.failed > 0
					? `${summary.failed} 个网址失败，可重试`
					: null);
	const isFullScope = (run.config as { seedUrls?: unknown } | null)?.seedUrls == null;

	const [finished] = await db
		.update(geoSiteCrawlRuns)
		.set({
			status,
			finishedAt: sql`now()`,
			errorSummary,
			counts: sql`jsonb_set(${geoSiteCrawlRuns.counts}, '{summary}', ${JSON.stringify(summary)}::jsonb, true)`,
		})
		.where(and(eq(geoSiteCrawlRuns.id, runId), inArray(geoSiteCrawlRuns.status, ["QUEUED", "RUNNING"])))
		.returning();
	if (!finished) return { status: run.status, continued: false, processed: 0 };
	if (status !== "FAILED") {
		await db.update(geoSiteSources).set({ lastSuccessAt: sql`now()` }).where(eq(geoSiteSources.id, source.id));
	}

	const organizationId = run.organizationId;
	const configVersion = (run.config as { profileVersion?: number } | null)?.profileVersion ?? 1;
	const profile = await loadProfileVersion(db, organizationId, source.id, configVersion).catch(() =>
		profileOfSource(source),
	);
	const alert = async (key: string, raise: boolean, input: Omit<Parameters<typeof raiseGeoAlert>[1], "dedupeKey" | "organizationId">) => {
		const dedupeKey = `${key}:${source.id}`;
		if (raise) await raiseGeoAlert(db, { ...input, organizationId, dedupeKey });
		else await resolveGeoAlert(db, { organizationId, dedupeKey });
	};

	await alert("site-sync-failed", status === "FAILED", {
		kind: "site.sync_failed",
		severity: "CRITICAL",
		context: { runId, errorSummary, baseUrl: source.baseUrl },
	});
	const blocked = summary.status403 + summary.status429;
	await alert(
		"site-blocked-responses",
		blocked >= 5 && summary.requests > 0 && blocked / summary.requests >= profile.alerts.blockedResponseRatio,
		{
			kind: "site.blocked_responses",
			severity: "WARNING",
			context: { runId, status403: summary.status403, status429: summary.status429, requests: summary.requests },
		},
	);
	if (isFullScope && status !== "FAILED") {
		const previous = await previousSections(db, source.id, runId);
		const keySections = profile.categories.filter((category) => category.keySection).map((category) => category.key);
		const drops = previous
			? keySections
					.map((key) => ({ key, before: previous[key] ?? 0, after: summary.sections[key] ?? 0 }))
					.filter(
						(entry) => entry.before >= 3 && entry.after < entry.before * (1 - profile.alerts.sectionDropRatio),
					)
			: [];
		await alert("site-section-drop", drops.length > 0, {
			kind: "site.section_drop",
			severity: "CRITICAL",
			context: { runId, drops },
		});
		const coverage = await keyUrlCoverageOf(db, organizationId, source);
		await alert("site-key-url-coverage", coverage.total > 0 && coverage.covered < coverage.total, {
			kind: "site.key_url_coverage",
			severity: "WARNING",
			context: { runId, total: coverage.total, covered: coverage.covered, missing: coverage.missing.slice(0, 20) },
		});
	}
	await writeGeoAudit(db, {
		principal: geoSystemPrincipal(organizationId, "site-crawl", `crawl-${runId}`),
		action: "site.crawl.finish",
		entityType: "site_crawl_run",
		entityId: runId,
		after: { status, summary },
	});
	return { status, continued: false, processed: 0 };
}
