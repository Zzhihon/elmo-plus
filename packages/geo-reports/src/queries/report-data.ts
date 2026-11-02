import type { GeoTaskState } from "@workspace/geo-domain";
import type { DbConnection } from "@workspace/lib/db/db-connection";
import {
	geoAssertionReviews,
	geoEvaluations,
	geoKnowledgeAssertions,
	geoOptimizationTasks,
	geoPublicationRecords,
	organization,
} from "@workspace/lib/db/schema";
import { and, desc, eq, gte, lt, notInArray, or, sql } from "drizzle-orm";
import { computeInsights } from "../insights";
import { GEO_METRIC_VERSION } from "../metrics";
import { chinaDate } from "../period";
import {
	BUSINESS_OUTCOME_NOTE,
	buildFindings,
	buildRisks,
	defaultNextPlan,
	evidencePath,
	GEO_REPORT_FORMAT,
	intermediateResults,
	methodology,
	type ReportBusinessInputs,
	type ReportSnapshot,
	type ReportTask,
} from "../report";
import { loadMetricData, promptSetRef } from "./samples";

export interface ReportRequest {
	organizationId: string;
	title: string;
	periodStart: Date;
	/** Exclusive. */
	periodEnd: Date;
	periodLabel: string;
	promptSetId: string | null;
	notes: string | null;
	nextPlan: string[] | null;
	crossModeSummary?: boolean;
}

const TASK_LIMIT = 200;

async function reportTasks(db: DbConnection, request: ReportRequest) {
	const t = geoOptimizationTasks;
	const columns = {
		id: t.id,
		title: t.title,
		state: t.state,
		priority: t.priority,
		publishedUrl: t.publishedUrl,
		publishedAt: t.publishedAt,
		afterBatchId: t.afterBatchId,
	};
	const inPeriod = (column: typeof t.publishedAt | typeof t.updatedAt) =>
		and(gte(column, request.periodStart), lt(column, request.periodEnd));
	const [executed, open] = await Promise.all([
		db
			.select(columns)
			.from(t)
			.where(
				and(
					eq(t.organizationId, request.organizationId),
					or(inPeriod(t.publishedAt), and(eq(t.state, "VERIFIED"), inPeriod(t.updatedAt))),
				),
			)
			.orderBy(desc(t.publishedAt))
			.limit(TASK_LIMIT),
		db
			.select(columns)
			.from(t)
			.where(
				and(
					eq(t.organizationId, request.organizationId),
					notInArray(t.state, ["VERIFIED", "CANCELLED"] satisfies GeoTaskState[]),
					lt(t.createdAt, request.periodEnd),
				),
			)
			.orderBy(t.priority, desc(t.updatedAt))
			.limit(TASK_LIMIT),
	]);
	const toTask = (row: (typeof executed)[number]): ReportTask => ({
		...row,
		publishedAt: row.publishedAt?.toISOString() ?? null,
	});
	return { executed: executed.map(toTask), open: open.map(toTask) };
}

async function businessInputs(db: DbConnection, request: ReportRequest): Promise<ReportBusinessInputs> {
	const count = sql<number>`count(*)::int`;
	const [[approved], [approvedInPeriod], [published], [tasksPublished]] = await Promise.all([
		db
			.select({ value: count })
			.from(geoKnowledgeAssertions)
			.where(
				and(
					eq(geoKnowledgeAssertions.organizationId, request.organizationId),
					eq(geoKnowledgeAssertions.status, "APPROVED"),
				),
			),
		db
			.select({ value: count })
			.from(geoAssertionReviews)
			.where(
				and(
					eq(geoAssertionReviews.organizationId, request.organizationId),
					eq(geoAssertionReviews.decision, "APPROVE"),
					gte(geoAssertionReviews.reviewedAt, request.periodStart),
					lt(geoAssertionReviews.reviewedAt, request.periodEnd),
				),
			),
		db
			.select({ value: count })
			.from(geoPublicationRecords)
			.where(
				and(
					eq(geoPublicationRecords.organizationId, request.organizationId),
					gte(geoPublicationRecords.publishedAt, request.periodStart),
					lt(geoPublicationRecords.publishedAt, request.periodEnd),
				),
			),
		db
			.select({ value: count })
			.from(geoOptimizationTasks)
			.where(
				and(
					eq(geoOptimizationTasks.organizationId, request.organizationId),
					gte(geoOptimizationTasks.publishedAt, request.periodStart),
					lt(geoOptimizationTasks.publishedAt, request.periodEnd),
				),
			),
	]);
	return {
		approvedAssertions: approved?.value ?? 0,
		approvedInPeriod: approvedInPeriod?.value ?? 0,
		publishedContentInPeriod: published?.value ?? 0,
		tasksPublishedInPeriod: tasksPublished?.value ?? 0,
	};
}

export async function reviewPoolSize(db: DbConnection, organizationId: string): Promise<number> {
	const [row] = await db
		.select({ value: sql<number>`count(*)::int` })
		.from(geoEvaluations)
		.where(
			and(
				eq(geoEvaluations.organizationId, organizationId),
				eq(geoEvaluations.isCurrent, true),
				eq(geoEvaluations.reviewStatus, "PENDING_REVIEW"),
			),
		);
	return row?.value ?? 0;
}

/**
 * Freezes everything a report says into one snapshot: the figures, the exact evaluation
 * versions behind them, and the narrative. PDF and CSV are rendered from it alone, so a
 * past month's report reads the same however the evidence is reviewed later.
 */
export async function assembleReportSnapshot(db: DbConnection, request: ReportRequest): Promise<ReportSnapshot> {
	const filter = { from: request.periodStart, to: request.periodEnd, promptSetId: request.promptSetId };
	const [data, promptSet, tasks, inputs, pending, [org]] = await Promise.all([
		loadMetricData(db, request.organizationId, filter),
		request.promptSetId ? promptSetRef(db, request.organizationId, request.promptSetId) : Promise.resolve(null),
		reportTasks(db, request),
		businessInputs(db, request),
		reviewPoolSize(db, request.organizationId),
		db.select({ slug: organization.slug }).from(organization).where(eq(organization.id, request.organizationId)),
	]);
	const insights = computeInsights({ ...data, crossMode: request.crossModeSummary });
	const from = chinaDate(request.periodStart);
	const to = chinaDate(new Date(request.periodEnd.getTime() - 1));
	return {
		format: GEO_REPORT_FORMAT,
		metricVersion: GEO_METRIC_VERSION,
		title: request.title,
		generatedAt: new Date().toISOString(),
		period: {
			start: request.periodStart.toISOString(),
			end: request.periodEnd.toISOString(),
			label: request.periodLabel,
			timezone: "Asia/Shanghai",
		},
		conditions: { promptSet, evaluatorVersions: insights.evaluatorVersions, targets: data.targets },
		methodology: methodology(promptSet, request.crossModeSummary),
		insights,
		competitors: data.competitors,
		findings: buildFindings(insights, data.competitors),
		tasks,
		risks: buildRisks({ insights, targets: data.targets, openTasks: tasks.open, reviewPoolPending: pending }),
		nextPlan:
			request.nextPlan && request.nextPlan.length > 0
				? request.nextPlan
				: defaultNextPlan({ promptSet, openTasks: tasks.open, reviewPoolPending: pending }),
		notes: request.notes,
		businessInputs: inputs,
		intermediateResults: intermediateResults(insights),
		businessOutcomes: [BUSINESS_OUTCOME_NOTE],
		reviewPoolPending: pending,
		evidenceLinks: insights.cells.map((cell) => ({
			platform: cell.platform,
			surfaceMode: cell.surfaceMode,
			path: evidencePath({
				organizationSlug: org?.slug ?? request.organizationId,
				platform: cell.platform,
				surfaceMode: cell.surfaceMode,
				promptSetId: request.promptSetId,
				from,
				to,
			}),
		})),
		evaluationRefs: data.samples.flatMap((sample) =>
			sample.evaluation
				? [
						[sample.observationId, sample.evaluation.evaluationId, sample.evaluation.version] as [
							string,
							string,
							number,
						],
					]
				: [],
		),
	};
}
