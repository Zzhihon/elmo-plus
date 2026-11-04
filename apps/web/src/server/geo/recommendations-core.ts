import {
	assertGeoPermission,
	GEO_QUEUE,
	GeoError,
	type GeoPrincipal,
	type GeoRecommendationKind,
	type GeoRecommendationStatus,
} from "@workspace/geo-domain";
import { loadCitationClassifications, loadRecommendationEvidence } from "@workspace/geo-reports/queries";
import {
	compareBrands,
	type RecommendationEvidence,
	type SurfaceModeComparison,
	taskKindForRecommendation,
} from "@workspace/geo-reports/recommendations";
import { siteAuditRule } from "@workspace/geo-site-ingestion/audit/catalog";
import { db } from "@workspace/lib/db/db";
import { geoBrandEntities, geoOptimizationTasks, geoRecommendations } from "@workspace/lib/db/schema";
import { writeGeoAudit } from "@workspace/lib/geo/audit";
import { createOptimizationTask } from "@workspace/lib/geo/tasks";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { enqueueGeoJob } from "@/lib/geo/enqueue";

export interface RecommendationItem {
	id: string;
	kind: GeoRecommendationKind;
	subjectKey: string;
	title: string;
	summary: string;
	contentType: (typeof geoRecommendations.$inferSelect)["contentType"];
	priority: (typeof geoRecommendations.$inferSelect)["priority"];
	impactScore: number;
	status: GeoRecommendationStatus;
	taskId: string | null;
	taskTitle: string | null;
	evidence: RecommendationEvidence;
	generatorVersion: string;
	updatedAt: string;
}

export async function listRecommendations(principal: GeoPrincipal) {
	assertGeoPermission(principal, "recommendation.read");
	const rows = await db
		.select({ recommendation: geoRecommendations, taskTitle: geoOptimizationTasks.title })
		.from(geoRecommendations)
		.leftJoin(geoOptimizationTasks, eq(geoOptimizationTasks.id, geoRecommendations.taskId))
		.where(eq(geoRecommendations.organizationId, principal.organizationId))
		.orderBy(desc(geoRecommendations.impactScore))
		.limit(500);
	const items: RecommendationItem[] = rows.map(({ recommendation: row, taskTitle }) => ({
		id: row.id,
		kind: row.kind,
		subjectKey: row.subjectKey,
		title: row.title,
		summary: row.summary,
		contentType: row.contentType,
		priority: row.priority,
		impactScore: row.impactScore,
		status: row.status,
		taskId: row.taskId,
		taskTitle,
		evidence: row.evidence as RecommendationEvidence,
		generatorVersion: row.generatorVersion,
		updatedAt: row.updatedAt.toISOString(),
	}));
	const lastGeneratedAt = items.reduce<string | null>(
		(latest, item) => (!latest || item.updatedAt > latest ? item.updatedAt : latest),
		null,
	);
	return { items, lastGeneratedAt };
}

export async function regenerateRecommendations(principal: GeoPrincipal) {
	assertGeoPermission(principal, "recommendation.generate");
	const jobId = await enqueueGeoJob(
		GEO_QUEUE.recommendations,
		{ organizationId: principal.organizationId },
		{ singletonKey: `recommendations:${principal.organizationId}`, singletonSeconds: 60 },
	);
	return { queued: jobId !== null };
}

export const recommendationDecisionSchema = z.object({
	recommendationId: z.guid(),
	note: z.string().trim().max(500).optional(),
});
export type RecommendationDecision = z.infer<typeof recommendationDecisionSchema>;

async function lockedRecommendation(
	tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
	organizationId: string,
	id: string,
) {
	const [row] = await tx
		.select()
		.from(geoRecommendations)
		.where(and(eq(geoRecommendations.organizationId, organizationId), eq(geoRecommendations.id, id)))
		.for("update");
	if (!row) throw new GeoError("NOT_FOUND", "建议不存在或不属于当前组织");
	return row;
}

/** The size of the evidence when someone decided, so regeneration only reopens it once that grows materially. */
function decidedEvidence(evidence: unknown): RecommendationEvidence {
	const current = evidence as RecommendationEvidence;
	return { ...current, decidedMeasure: current.measure ?? 0 };
}

export async function dismissRecommendation(principal: GeoPrincipal, input: RecommendationDecision) {
	assertGeoPermission(principal, "recommendation.triage");
	return db.transaction(async (tx) => {
		const before = await lockedRecommendation(tx, principal.organizationId, input.recommendationId);
		if (before.status !== "OPEN") throw new GeoError("CONFLICT", "只有待处理的建议可以忽略");
		const [after] = await tx
			.update(geoRecommendations)
			.set({
				status: "DISMISSED",
				evidence: decidedEvidence(before.evidence),
				decidedBy: principal.actorId,
				decidedAt: new Date(),
				updatedAt: new Date(),
			})
			.where(eq(geoRecommendations.id, before.id))
			.returning();
		await writeGeoAudit(tx, {
			principal,
			action: "recommendation.dismiss",
			entityType: "geo_recommendation",
			entityId: before.id,
			before,
			after,
			metadata: { kind: before.kind, subjectKey: before.subjectKey, note: input.note ?? null },
		});
		return { id: before.id, status: "DISMISSED" as const };
	});
}

export async function restoreRecommendation(principal: GeoPrincipal, input: RecommendationDecision) {
	assertGeoPermission(principal, "recommendation.triage");
	return db.transaction(async (tx) => {
		const before = await lockedRecommendation(tx, principal.organizationId, input.recommendationId);
		if (before.status !== "DISMISSED") throw new GeoError("CONFLICT", "只有已忽略的建议可以恢复");
		const [after] = await tx
			.update(geoRecommendations)
			.set({ status: "OPEN", decidedBy: null, decidedAt: null, updatedAt: new Date() })
			.where(eq(geoRecommendations.id, before.id))
			.returning();
		await writeGeoAudit(tx, {
			principal,
			action: "recommendation.restore",
			entityType: "geo_recommendation",
			entityId: before.id,
			before,
			after,
		});
		return { id: before.id, status: "OPEN" as const };
	});
}

const TASK_EVIDENCE_LIMIT = 100;

export async function convertRecommendationToTask(principal: GeoPrincipal, input: RecommendationDecision) {
	assertGeoPermission(principal, "recommendation.triage");
	assertGeoPermission(principal, "task.create");
	return db.transaction(async (tx) => {
		const before = await lockedRecommendation(tx, principal.organizationId, input.recommendationId);
		if (before.status !== "OPEN") throw new GeoError("CONFLICT", "只有待处理的建议可以转为工单");
		const evidence = before.evidence as RecommendationEvidence;
		const observationIds = (evidence.observationIds ?? []).slice(0, TASK_EVIDENCE_LIMIT);
		const findingIds = (evidence.findingIds ?? []).slice(0, TASK_EVIDENCE_LIMIT);
		if (observationIds.length + findingIds.length === 0) {
			throw new GeoError("EVIDENCE_REQUIRED", "这条建议没有可关联的证据，请重新生成后再转工单");
		}
		const { task, created } = await createOptimizationTask(tx, principal, {
			title: before.title.slice(0, 200),
			kind: taskKindForRecommendation({
				kind: before.kind,
				contentType: before.contentType,
				ruleTaskKind: before.kind === "SITE_FIX" ? siteAuditRule(before.subjectKey)?.taskKind : null,
			}),
			sourceKind: "RECOMMENDATION",
			sourceRef: before.id,
			priority: before.priority,
			promptId: evidence.promptIds?.length === 1 ? evidence.promptIds[0] : null,
			recommendedAction: [evidence.action, before.summary].filter(Boolean).join("\n\n").slice(0, 4000),
			expectedMetric: before.kind === "SITE_FIX" ? "审计问题关闭" : "相关问题中被 AI 提到的比例上升",
			evidence: { observationIds, findingIds },
			comment: input.note ?? null,
		});
		const [after] = await tx
			.update(geoRecommendations)
			.set({
				status: "CONVERTED",
				taskId: task.id,
				evidence: decidedEvidence(before.evidence),
				decidedBy: principal.actorId,
				decidedAt: new Date(),
				updatedAt: new Date(),
			})
			.where(eq(geoRecommendations.id, before.id))
			.returning();
		await writeGeoAudit(tx, {
			principal,
			action: "recommendation.convert",
			entityType: "geo_recommendation",
			entityId: before.id,
			before,
			after,
			metadata: { taskId: task.id, created },
		});
		return { id: before.id, taskId: task.id, created };
	});
}

export interface CompetitorComparison {
	promptSet: { id: string; name: string; version: number } | null;
	from: string;
	to: string;
	modes: SurfaceModeComparison[];
}

export async function getCompetitorComparison(principal: GeoPrincipal): Promise<CompetitorComparison> {
	assertGeoPermission(principal, "recommendation.read");
	const evidence = await loadRecommendationEvidence(db, principal.organizationId);
	const [classifications, own] = await Promise.all([
		loadCitationClassifications(
			db,
			evidence.citations.map((citation) => citation.url),
		),
		db
			.select({ name: geoBrandEntities.displayName, shortName: geoBrandEntities.shortName })
			.from(geoBrandEntities)
			.where(
				and(
					eq(geoBrandEntities.organizationId, principal.organizationId),
					eq(geoBrandEntities.kind, "OWN"),
					eq(geoBrandEntities.status, "ACTIVE"),
				),
			)
			.limit(1),
	]);
	return {
		promptSet: evidence.promptSet,
		from: evidence.from.toISOString(),
		to: evidence.to.toISOString(),
		modes: compareBrands({
			samples: evidence.samples,
			competitors: evidence.competitors,
			ownName: own[0]?.shortName || own[0]?.name || "我们",
			citations: evidence.citations,
			classifications,
		}),
	};
}
