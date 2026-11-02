import {
	assertGeoPermission,
	GeoError,
	type GeoPrincipal,
	type GeoPriority,
	type GeoRiskLevel,
	type GeoTaskKind,
	type GeoTaskSourceKind,
} from "@workspace/geo-domain";
import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";
import type { DbConnection } from "../db/db-connection";
import {
	geoKnowledgeAssertions,
	geoObservations,
	geoOptimizationTasks,
	geoPrompts,
	geoSamplingBatches,
	geoSiteAuditFindings,
	geoTaskEvents,
	geoTaskEvidence,
} from "../db/schema-geo";
import { writeGeoAudit } from "./audit";

export interface CreateOptimizationTaskInput {
	title: string;
	kind: GeoTaskKind;
	sourceKind: GeoTaskSourceKind;
	/** What the task came from. A second call for a source with an open task returns that task. */
	sourceRef?: string | null;
	priority?: GeoPriority;
	riskLevel?: GeoRiskLevel;
	promptId?: string | null;
	ownerId?: string | null;
	recommendedAction?: string | null;
	expectedMetric?: string | null;
	beforeBatchId?: string | null;
	evidence?: {
		observationIds?: string[];
		findingIds?: string[];
		assertionIds?: string[];
	};
	comment?: string | null;
}

export type GeoOptimizationTask = typeof geoOptimizationTasks.$inferSelect;

const INITIAL_STATE = "PENDING_ANALYSIS";

async function assertAllInOrganization(
	tx: DbConnection,
	table: PgTable,
	idColumn: AnyPgColumn,
	organizationColumn: AnyPgColumn,
	organizationId: string,
	ids: string[],
	what: string,
): Promise<void> {
	if (ids.length === 0) return;
	const rows = await tx
		.select({ id: idColumn })
		.from(table)
		.where(and(inArray(idColumn, ids), eq(organizationColumn, organizationId)));
	if (rows.length !== new Set(ids).size) {
		throw new GeoError("NOT_FOUND", `${what}不存在或不属于当前组织`);
	}
}

async function assertReferencesInOrganization(
	tx: DbConnection,
	organizationId: string,
	input: CreateOptimizationTaskInput,
): Promise<void> {
	const { evidence = {} } = input;
	await assertAllInOrganization(
		tx,
		geoObservations,
		geoObservations.id,
		geoObservations.organizationId,
		organizationId,
		evidence.observationIds ?? [],
		"采样证据",
	);
	await assertAllInOrganization(
		tx,
		geoSiteAuditFindings,
		geoSiteAuditFindings.id,
		geoSiteAuditFindings.organizationId,
		organizationId,
		evidence.findingIds ?? [],
		"站点审计发现",
	);
	await assertAllInOrganization(
		tx,
		geoKnowledgeAssertions,
		geoKnowledgeAssertions.id,
		geoKnowledgeAssertions.organizationId,
		organizationId,
		evidence.assertionIds ?? [],
		"知识断言",
	);
	await assertAllInOrganization(
		tx,
		geoPrompts,
		geoPrompts.id,
		geoPrompts.organizationId,
		organizationId,
		input.promptId ? [input.promptId] : [],
		"问法",
	);
	await assertAllInOrganization(
		tx,
		geoSamplingBatches,
		geoSamplingBatches.id,
		geoSamplingBatches.organizationId,
		organizationId,
		input.beforeBatchId ? [input.beforeBatchId] : [],
		"采样批次",
	);
}

function evidenceRows(organizationId: string, taskId: string, input: CreateOptimizationTaskInput) {
	const { observationIds = [], findingIds = [], assertionIds = [] } = input.evidence ?? {};
	return [
		...[...new Set(observationIds)].map((observationId) => ({ organizationId, taskId, observationId })),
		...[...new Set(findingIds)].map((findingId) => ({ organizationId, taskId, findingId })),
		...[...new Set(assertionIds)].map((assertionId) => ({ organizationId, taskId, assertionId })),
	];
}

function assertValidInput(input: CreateOptimizationTaskInput): void {
	if (!input.title.trim()) throw new GeoError("VALIDATION_ERROR", "工单标题不能为空");
	if (input.sourceKind === "MANUAL") return;
	if (!input.sourceRef) throw new GeoError("VALIDATION_ERROR", "从证据创建工单必须说明来源");
	const { observationIds = [], findingIds = [], assertionIds = [] } = input.evidence ?? {};
	if (observationIds.length + findingIds.length + assertionIds.length === 0) {
		throw new GeoError("EVIDENCE_REQUIRED", "从证据创建工单必须关联诊断证据");
	}
}

async function findOpenTaskForSource(
	tx: DbConnection,
	organizationId: string,
	sourceKind: GeoTaskSourceKind,
	sourceRef: string,
): Promise<GeoOptimizationTask | undefined> {
	const [row] = await tx
		.select()
		.from(geoOptimizationTasks)
		.where(
			and(
				eq(geoOptimizationTasks.organizationId, organizationId),
				eq(geoOptimizationTasks.sourceKind, sourceKind),
				eq(geoOptimizationTasks.sourceRef, sourceRef),
				notInArray(geoOptimizationTasks.state, ["VERIFIED", "CANCELLED"]),
			),
		)
		.limit(1);
	return row;
}

async function recordNewTask(
	tx: DbConnection,
	principal: GeoPrincipal,
	task: GeoOptimizationTask,
	input: CreateOptimizationTaskInput,
): Promise<void> {
	const { organizationId } = principal;
	const evidence = evidenceRows(organizationId, task.id, input);
	if (evidence.length > 0) await tx.insert(geoTaskEvidence).values(evidence);

	const findingIds = input.evidence?.findingIds ?? [];
	if (findingIds.length > 0) {
		await tx
			.update(geoSiteAuditFindings)
			.set({ status: "TASKED", taskId: task.id })
			.where(
				and(
					eq(geoSiteAuditFindings.organizationId, organizationId),
					inArray(geoSiteAuditFindings.id, findingIds),
					eq(geoSiteAuditFindings.status, "OPEN"),
				),
			);
	}

	await tx.insert(geoTaskEvents).values({
		organizationId,
		taskId: task.id,
		fromState: null,
		toState: INITIAL_STATE,
		action: "CREATE",
		actorId: principal.actorId,
		comment: input.comment ?? null,
	});

	await writeGeoAudit(tx, {
		principal,
		action: "task.create",
		entityType: "geo_optimization_task",
		entityId: task.id,
		after: task,
		metadata: { sourceKind: input.sourceKind, sourceRef: task.sourceRef, evidenceCount: evidence.length },
	});
}

/**
 * Every task starts here, whichever slice raised it, so each one begins with its
 * evidence, a first event and an audit row. A principal that is `system` skips the
 * permission check because a worker has no roles; everything else needs `task.create`.
 */
export async function createOptimizationTask(
	tx: DbConnection,
	principal: GeoPrincipal,
	input: CreateOptimizationTaskInput,
): Promise<{ task: GeoOptimizationTask; created: boolean }> {
	if (principal.actorKind !== "system") assertGeoPermission(principal, "task.create");
	assertValidInput(input);

	const { organizationId } = principal;
	await assertReferencesInOrganization(tx, organizationId, input);

	const sourceRef = input.sourceRef ?? null;
	const [task] = await tx
		.insert(geoOptimizationTasks)
		.values({
			organizationId,
			title: input.title.trim(),
			kind: input.kind,
			state: INITIAL_STATE,
			priority: input.priority ?? "P2",
			riskLevel: input.riskLevel ?? "NORMAL",
			promptId: input.promptId ?? null,
			ownerId: input.ownerId ?? null,
			recommendedAction: input.recommendedAction ?? null,
			expectedMetric: input.expectedMetric ?? null,
			beforeBatchId: input.beforeBatchId ?? null,
			sourceKind: input.sourceKind,
			sourceRef,
			createdBy: principal.actorId,
		})
		.onConflictDoNothing({
			target: [geoOptimizationTasks.organizationId, geoOptimizationTasks.sourceKind, geoOptimizationTasks.sourceRef],
			where: sql`${geoOptimizationTasks.sourceRef} is not null and ${geoOptimizationTasks.state} not in ('VERIFIED', 'CANCELLED')`,
		})
		.returning();

	if (!task) {
		const existing = await findOpenTaskForSource(tx, organizationId, input.sourceKind, sourceRef as string);
		if (!existing) throw new GeoError("CONFLICT", "同一来源的工单正在创建，请稍后重试");
		return { task: existing, created: false };
	}

	await recordNewTask(tx, principal, task, input);
	return { task, created: true };
}
