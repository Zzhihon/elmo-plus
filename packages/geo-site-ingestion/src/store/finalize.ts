import {
	type GeoCrawlItemOutcome,
	type GeoCrawlItemStatus,
	type GeoCrawlStatus,
	geoSystemPrincipal,
} from "@workspace/geo-domain";
import type { DbConnection } from "@workspace/lib/db/db-connection";
import { geoSiteCrawlItems, geoSiteCrawlRuns, geoSitePages, geoSiteSources } from "@workspace/lib/db/schema";
import { raiseGeoAlert, resolveGeoAlert } from "@workspace/lib/geo/alerts";
import { writeGeoAudit } from "@workspace/lib/geo/audit";
import { and, count, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { enqueueSiteAuditAfterCrawl } from "../audit/store";
import type { SiteProfile } from "../profile";
import type { SiteJobDeps } from "./deps";
import { keyUrlCoverageOf } from "./metrics";
import { loadProfileVersion, profileOfSource } from "./sources";

export const SUCCESS_OUTCOMES: GeoCrawlItemOutcome[] = ["NEW_VERSION", "UNCHANGED", "REVERTED", "DUPLICATE"];

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
	reverted: number;
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

function roundOrNull(value: number | null | undefined): number | null {
	return value === null || value === undefined ? null : Math.round(Number(value));
}

function emptySummary(sectionRows: Array<{ category: string | null; pages: number }>): CrawlRunSummary {
	return {
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
		reverted: 0,
		duplicates: 0,
		gone: 0,
		status403: 0,
		status429: 0,
		p50Ms: null,
		p95Ms: null,
		successRate: null,
		unchangedRate: null,
		sections: Object.fromEntries(sectionRows.map((row) => [row.category ?? "uncategorized", row.pages])),
	};
}

const STATUS_BUCKET: Partial<Record<GeoCrawlItemStatus, "queued" | "done" | "failed" | "skipped">> = {
	QUEUED: "queued",
	FETCHING: "queued",
	DONE: "done",
	FAILED: "failed",
	SKIPPED: "skipped",
};

function tally(
	summary: CrawlRunSummary,
	grouped: Array<{ status: GeoCrawlItemStatus; outcome: GeoCrawlItemOutcome | null; items: number; attempts: number }>,
): void {
	for (const row of grouped) {
		summary.total += row.items;
		summary.requests += Number(row.attempts);
		const bucket = STATUS_BUCKET[row.status];
		if (bucket) summary[bucket] += row.items;
		if (row.outcome) summary.outcomes[row.outcome] = (summary.outcomes[row.outcome] ?? 0) + row.items;
	}
	summary.newVersions = summary.outcomes.NEW_VERSION ?? 0;
	summary.unchanged = summary.outcomes.UNCHANGED ?? 0;
	summary.reverted = summary.outcomes.REVERTED ?? 0;
	summary.duplicates = summary.outcomes.DUPLICATE ?? 0;
	summary.gone = summary.outcomes.GONE ?? 0;
	summary.succeeded = summary.newVersions + summary.unchanged + summary.reverted + summary.duplicates;
	const attempted = summary.succeeded + summary.failed + summary.gone;
	summary.successRate = attempted === 0 ? null : summary.succeeded / attempted;
	summary.unchangedRate = summary.succeeded === 0 ? null : summary.unchanged / summary.succeeded;
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

	const summary = emptySummary(sectionRows);
	summary.status403 = timing?.status403 ?? 0;
	summary.status429 = timing?.status429 ?? 0;
	summary.p50Ms = roundOrNull(timing?.p50);
	summary.p95Ms = roundOrNull(timing?.p95);
	tally(summary, grouped);
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

export function finalStatusOf(
	summary: CrawlRunSummary,
	options: { forcedStatus?: GeoCrawlStatus; errorSummary?: string },
): { status: GeoCrawlStatus; errorSummary: string | null } {
	const budgetHit = (summary.outcomes.BUDGET_EXCEEDED ?? 0) > 0;
	let status: GeoCrawlStatus = "SUCCEEDED";
	let message: string | null = null;
	if (summary.succeeded === 0 && summary.gone === 0) {
		status = "FAILED";
		message = "没有成功采集到任何页面";
	} else if (budgetHit) {
		status = "PARTIAL";
		message = "达到页面预算，剩余网址未采集";
	} else if (summary.failed > 0) {
		status = "PARTIAL";
		message = `${summary.failed} 个网址失败，可重试`;
	}
	return { status: options.forcedStatus ?? status, errorSummary: options.errorSummary ?? message };
}

type RunRow = typeof geoSiteCrawlRuns.$inferSelect;
type SourceRow = typeof geoSiteSources.$inferSelect;

async function setAlert(
	db: DbConnection,
	organizationId: string,
	dedupeKey: string,
	raise: boolean,
	alert: { kind: string; severity: "CRITICAL" | "WARNING"; context: Record<string, unknown> },
): Promise<void> {
	if (raise) await raiseGeoAlert(db, { ...alert, organizationId, dedupeKey });
	else await resolveGeoAlert(db, { organizationId, dedupeKey });
}

/** Alerts that compare a whole-site run with the previous one; a run limited to chosen URLs says nothing about them. */
async function evaluateCoverageAlerts(
	db: DbConnection,
	run: RunRow,
	source: SourceRow,
	summary: CrawlRunSummary,
	profile: SiteProfile,
): Promise<void> {
	const previous = await previousSections(db, source.id, run.id);
	const drops = previous
		? profile.categories
				.filter((category) => category.keySection)
				.map((category) => ({
					key: category.key,
					before: previous[category.key] ?? 0,
					after: summary.sections[category.key] ?? 0,
				}))
				.filter((entry) => entry.before >= 3 && entry.after < entry.before * (1 - profile.alerts.sectionDropRatio))
		: [];
	await setAlert(db, run.organizationId, `site-section-drop:${source.id}`, drops.length > 0, {
		kind: "site.section_drop",
		severity: "CRITICAL",
		context: { runId: run.id, drops },
	});
	const coverage = await keyUrlCoverageOf(db, run.organizationId, source);
	await setAlert(
		db,
		run.organizationId,
		`site-key-url-coverage:${source.id}`,
		coverage.total > 0 && coverage.covered < coverage.total,
		{
			kind: "site.key_url_coverage",
			severity: "WARNING",
			context: {
				runId: run.id,
				total: coverage.total,
				covered: coverage.covered,
				missing: coverage.missing.slice(0, 20),
			},
		},
	);
}

async function evaluateRunAlerts(
	db: DbConnection,
	run: RunRow,
	source: SourceRow,
	summary: CrawlRunSummary,
	outcome: { status: GeoCrawlStatus; errorSummary: string | null },
): Promise<void> {
	const configVersion = (run.config as { profileVersion?: number } | null)?.profileVersion ?? 1;
	const profile = await loadProfileVersion(db, run.organizationId, source.id, configVersion).catch(() =>
		profileOfSource(source),
	);
	await setAlert(db, run.organizationId, `site-sync-failed:${source.id}`, outcome.status === "FAILED", {
		kind: "site.sync_failed",
		severity: "CRITICAL",
		context: { runId: run.id, errorSummary: outcome.errorSummary, baseUrl: source.baseUrl },
	});
	const blocked = summary.status403 + summary.status429;
	await setAlert(
		db,
		run.organizationId,
		`site-blocked-responses:${source.id}`,
		blocked >= 5 && summary.requests > 0 && blocked / summary.requests >= profile.alerts.blockedResponseRatio,
		{
			kind: "site.blocked_responses",
			severity: "WARNING",
			context: {
				runId: run.id,
				status403: summary.status403,
				status429: summary.status429,
				requests: summary.requests,
			},
		},
	);
	const isFullScope = (run.config as { seedUrls?: unknown } | null)?.seedUrls == null;
	if (isFullScope && outcome.status !== "FAILED") await evaluateCoverageAlerts(db, run, source, summary, profile);
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
	const outcome = finalStatusOf(summary, options);

	const [finished] = await db
		.update(geoSiteCrawlRuns)
		.set({
			status: outcome.status,
			finishedAt: sql`now()`,
			errorSummary: outcome.errorSummary,
			counts: sql`jsonb_set(${geoSiteCrawlRuns.counts}, '{summary}', ${JSON.stringify(summary)}::jsonb, true)`,
		})
		.where(and(eq(geoSiteCrawlRuns.id, runId), inArray(geoSiteCrawlRuns.status, ["QUEUED", "RUNNING"])))
		.returning();
	if (!finished) return { status: run.status, continued: false, processed: 0 };
	if (outcome.status !== "FAILED") {
		await db.update(geoSiteSources).set({ lastSuccessAt: sql`now()` }).where(eq(geoSiteSources.id, source.id));
	}
	await evaluateRunAlerts(db, run, source, summary, outcome);
	await writeGeoAudit(db, {
		principal: geoSystemPrincipal(run.organizationId, "site-crawl", `crawl-${runId}`),
		action: "site.crawl.finish",
		entityType: "site_crawl_run",
		entityId: runId,
		after: { status: outcome.status, summary },
	});
	if (outcome.status === "SUCCEEDED" || outcome.status === "PARTIAL") {
		const fullScope = (run.config as { seedUrls?: unknown } | null)?.seedUrls == null;
		await enqueueSiteAuditAfterCrawl(deps, {
			id: runId,
			organizationId: run.organizationId,
			siteSourceId: source.id,
			fullScope,
		});
	}
	return { status: outcome.status, continued: false, processed: 0 };
}
