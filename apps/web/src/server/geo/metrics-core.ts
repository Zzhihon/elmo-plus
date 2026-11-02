import {
	assertGeoPermission,
	GEO_PLATFORMS,
	GEO_SURFACE_MODES,
	GeoError,
	type GeoPlatform,
	type GeoPrincipal,
	type GeoSurfaceMode,
} from "@workspace/geo-domain";
import {
	type BatchComparison,
	type CompetitorRef,
	chinaDate,
	chinaDayRange,
	computeInsights,
	GEO_METRIC_VERSION,
	type Insights,
	type ReportTarget,
} from "@workspace/geo-reports";
import {
	compareOrganizationBatches,
	defaultPromptSet,
	loadMetricData,
	type PromptSetRef,
	promptSetRef,
	reviewPoolSize,
	sampledPromptSets,
} from "@workspace/geo-reports/queries";
import { db } from "@workspace/lib/db/db";
import {
	geoGeneratedReports,
	geoObservationClaims,
	geoObservations,
	geoOptimizationTasks,
	geoSamplingBatches,
} from "@workspace/lib/db/schema";
import { and, desc, eq, gte, inArray, lt, notInArray, or, sql } from "drizzle-orm";
import { z } from "zod";

/** Default window: the last four weeks, long enough for one round a week to show a trend. */
export const GEO_DEFAULT_WINDOW_DAYS = 28;
const MAX_WINDOW_DAYS = 370;

export const metricQuerySchema = z.object({
	from: z.iso.date().optional(),
	to: z.iso.date().optional(),
	promptSetId: z.guid().optional(),
	platform: z.enum(GEO_PLATFORMS).optional(),
	surfaceMode: z.enum(GEO_SURFACE_MODES).optional(),
});
export type MetricQuery = z.infer<typeof metricQuerySchema>;

export interface MetricMeta {
	from: string;
	to: string;
	promptSet: PromptSetRef | null;
	promptSets: (PromptSetRef & { observations: number })[];
	platform: GeoPlatform | null;
	surfaceMode: GeoSurfaceMode | null;
	surfaceModes: GeoSurfaceMode[];
	validSamples: number;
	updatedAt: string | null;
	metricVersion: string;
	evaluatorVersions: string[];
}

export interface InsightsResult {
	meta: MetricMeta;
	insights: Insights;
	competitors: CompetitorRef[];
	targets: ReportTarget[];
}

function resolveWindow(query: MetricQuery): { from: string; to: string } {
	const to = query.to ?? chinaDate(new Date());
	const from =
		query.from ??
		chinaDate(new Date(new Date(`${to}T00:00:00+08:00`).getTime() - (GEO_DEFAULT_WINDOW_DAYS - 1) * 86_400_000));
	if (from > to) throw new GeoError("VALIDATION_ERROR", "开始日期不能晚于结束日期");
	const days = (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1;
	if (days > MAX_WINDOW_DAYS) throw new GeoError("VALIDATION_ERROR", `时间窗口最长 ${MAX_WINDOW_DAYS} 天`);
	return { from, to };
}

/**
 * Metrics for one fixed comparison: one question-set version, a date window, and
 * optionally one platform or surface mode. Without a set the most sampled one in the
 * window is used, so a page never silently mixes question-set versions.
 */
export async function getInsights(principal: GeoPrincipal, query: MetricQuery): Promise<InsightsResult> {
	assertGeoPermission(principal, "metric.read");
	const { organizationId } = principal;
	const window = resolveWindow(query);
	const range = chinaDayRange(window.from, window.to);
	const [promptSet, promptSets] = await Promise.all([
		query.promptSetId
			? promptSetRef(db, organizationId, query.promptSetId)
			: defaultPromptSet(db, organizationId, { from: range.start, to: range.end }),
		sampledPromptSets(db, organizationId),
	]);
	if (query.promptSetId && !promptSet) throw new GeoError("NOT_FOUND", "问法集不存在");
	const data = await loadMetricData(db, organizationId, {
		from: range.start,
		to: range.end,
		promptSetId: promptSet?.id ?? null,
		platform: query.platform,
		surfaceMode: query.surfaceMode,
	});
	const insights = computeInsights(data);
	return {
		meta: {
			...window,
			promptSet,
			promptSets,
			platform: query.platform ?? null,
			surfaceMode: query.surfaceMode ?? null,
			surfaceModes: [...new Set(insights.cells.map((cell) => cell.surfaceMode))],
			validSamples: insights.totals.valid,
			updatedAt: data.updatedAt,
			metricVersion: GEO_METRIC_VERSION,
			evaluatorVersions: insights.evaluatorVersions,
		},
		insights,
		competitors: data.competitors,
		targets: data.targets,
	};
}

export interface RecentCell {
	platform: GeoPlatform;
	surfaceMode: GeoSurfaceMode;
	total: number;
	valid: number;
	notValid: number;
	mentioned: number;
	evaluated: number;
}

export interface OverviewResult extends InsightsResult {
	recent: { from: string; to: string; cells: RecentCell[] };
	pending: { reviewPool: number; reportsToReview: number; openTasks: number; runningBatches: number };
}

/** What happened in the last seven days, per platform and mode, counted straight from the evidence. */
async function recentResults(organizationId: string): Promise<OverviewResult["recent"]> {
	const to = chinaDate(new Date());
	const from = chinaDate(new Date(Date.now() - 6 * 86_400_000));
	const range = chinaDayRange(from, to);
	const result = await db.execute(sql`
		select o.platform, o.surface_mode,
			count(*)::int as total,
			count(*) filter (where o.status = 'VALID')::int as valid,
			count(e.id) filter (where o.status = 'VALID')::int as evaluated,
			count(e.id) filter (where o.status = 'VALID' and e.brand_mentioned)::int as mentioned
		from ${geoObservations} o
		left join geo_evaluations e on e.observation_id = o.id and e.is_current
		where o.organization_id = ${organizationId}
			and o.sampled_at >= ${range.start} and o.sampled_at < ${range.end}
		group by o.platform, o.surface_mode
	`);
	const cells = (result.rows as Record<string, unknown>[]).map((row) => ({
		platform: row.platform as GeoPlatform,
		surfaceMode: row.surface_mode as GeoSurfaceMode,
		total: Number(row.total),
		valid: Number(row.valid),
		notValid: Number(row.total) - Number(row.valid),
		mentioned: Number(row.mentioned),
		evaluated: Number(row.evaluated),
	}));
	cells.sort(
		(a, b) =>
			GEO_PLATFORMS.indexOf(a.platform) - GEO_PLATFORMS.indexOf(b.platform) ||
			GEO_SURFACE_MODES.indexOf(a.surfaceMode) - GEO_SURFACE_MODES.indexOf(b.surfaceMode),
	);
	return { from, to, cells };
}

async function pendingWork(organizationId: string): Promise<OverviewResult["pending"]> {
	const countOf = sql<number>`count(*)::int`;
	const [reviewPool, [reports], [tasks], [batches]] = await Promise.all([
		reviewPoolSize(db, organizationId),
		db
			.select({ value: countOf })
			.from(geoGeneratedReports)
			.where(
				and(
					eq(geoGeneratedReports.organizationId, organizationId),
					eq(geoGeneratedReports.status, "SUCCEEDED"),
					eq(geoGeneratedReports.reviewStatus, "PENDING"),
				),
			),
		db
			.select({ value: countOf })
			.from(geoOptimizationTasks)
			.where(
				and(
					eq(geoOptimizationTasks.organizationId, organizationId),
					notInArray(geoOptimizationTasks.state, ["VERIFIED", "CANCELLED"]),
				),
			),
		db
			.select({ value: countOf })
			.from(geoSamplingBatches)
			.where(
				and(
					eq(geoSamplingBatches.organizationId, organizationId),
					inArray(geoSamplingBatches.status, ["PLANNED", "RUNNING"]),
					gte(geoSamplingBatches.createdAt, new Date(Date.now() - 30 * 86_400_000)),
				),
			),
	]);
	return {
		reviewPool,
		reportsToReview: reports?.value ?? 0,
		openTasks: tasks?.value ?? 0,
		runningBatches: batches?.value ?? 0,
	};
}

export async function getOverview(principal: GeoPrincipal): Promise<OverviewResult> {
	const [insights, recent, pending] = await Promise.all([
		getInsights(principal, {}),
		recentResults(principal.organizationId),
		pendingWork(principal.organizationId),
	]);
	return { ...insights, recent, pending };
}

export const batchComparisonQuerySchema = z.object({
	before: z.guid("基线批次 ID 无效"),
	after: z.guid("复测批次 ID 无效"),
	promptId: z.guid().optional(),
});

/** Two rounds under the same conditions; the task retest view and API both read this. */
export async function compareBatchesFor(
	principal: GeoPrincipal,
	query: z.infer<typeof batchComparisonQuerySchema>,
): Promise<
	BatchComparison & { before: { id: string; promptSetId: string }; after: { id: string; promptSetId: string } }
> {
	assertGeoPermission(principal, "metric.read");
	if (query.before === query.after) throw new GeoError("VALIDATION_ERROR", "基线批次与复测批次不能相同");
	const batches = await db
		.select({ id: geoSamplingBatches.id, promptSetId: geoSamplingBatches.promptSetId })
		.from(geoSamplingBatches)
		.where(
			and(
				eq(geoSamplingBatches.organizationId, principal.organizationId),
				inArray(geoSamplingBatches.id, [query.before, query.after]),
			),
		);
	const before = batches.find((batch) => batch.id === query.before);
	const after = batches.find((batch) => batch.id === query.after);
	if (!before || !after) throw new GeoError("NOT_FOUND", "批次不存在");
	if (before.promptSetId !== after.promptSetId) {
		throw new GeoError("VALIDATION_ERROR", "两个批次使用的问法集版本不同，不能按相同条件对比");
	}
	const comparison = await compareOrganizationBatches(
		db,
		principal.organizationId,
		before.id,
		after.id,
		query.promptId ?? null,
	);
	return { ...comparison, before, after };
}

export interface ClaimIssue {
	claimId: string;
	observationId: string;
	questionText: string;
	platform: GeoPlatform;
	surfaceMode: GeoSurfaceMode;
	sampledAt: string;
	claimKind: string;
	claimText: string;
	extractedValue: string | null;
	referenceValue: string | null;
	verdict: string;
	matchStatus: string;
	reviewNote: string | null;
}

const CLAIM_ISSUE_LIMIT = 200;

/**
 * The error-description list: errors a technical reviewer confirmed, then statements
 * that disagree with approved knowledge and are waiting for that review, for the same
 * window and question set as the metrics.
 */
export async function listClaimIssues(principal: GeoPrincipal, query: MetricQuery): Promise<ClaimIssue[]> {
	assertGeoPermission(principal, "metric.read");
	const window = resolveWindow(query);
	const range = chinaDayRange(window.from, window.to);
	const c = geoObservationClaims;
	const o = geoObservations;
	const rows = await db
		.select({
			claimId: c.id,
			observationId: o.id,
			questionText: o.questionText,
			platform: o.platform,
			surfaceMode: o.surfaceMode,
			sampledAt: o.sampledAt,
			claimKind: c.claimKind,
			claimText: c.claimText,
			extractedValue: c.extractedValue,
			referenceValue: c.referenceValue,
			verdict: c.verdict,
			matchStatus: c.matchStatus,
			reviewNote: c.reviewNote,
		})
		.from(c)
		.innerJoin(o, eq(o.id, c.observationId))
		.where(
			and(
				eq(c.organizationId, principal.organizationId),
				eq(o.status, "VALID"),
				gte(o.sampledAt, range.start),
				lt(o.sampledAt, range.end),
				query.promptSetId ? eq(o.promptSetId, query.promptSetId) : undefined,
				query.platform ? eq(o.platform, query.platform) : undefined,
				query.surfaceMode ? eq(o.surfaceMode, query.surfaceMode) : undefined,
				or(eq(c.verdict, "ERROR"), and(eq(c.verdict, "UNVERIFIED"), eq(c.matchStatus, "MISMATCH"))),
			),
		)
		.orderBy(desc(sql`${c.verdict} = 'ERROR'`), desc(o.sampledAt))
		.limit(CLAIM_ISSUE_LIMIT);
	return rows.map((row) => ({ ...row, sampledAt: row.sampledAt.toISOString() }));
}

/** Question sets with any sampled answer: the choices for a report or a comparison. */
export async function listSampledPromptSets(principal: GeoPrincipal) {
	assertGeoPermission(principal, "metric.read");
	return sampledPromptSets(db, principal.organizationId);
}
