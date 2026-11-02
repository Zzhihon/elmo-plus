import {
	assertGeoPermission,
	assertGeoTransition,
	GEO_PRIORITIES,
	GEO_RISK_LEVELS,
	GEO_TASK_ACTIONS,
	GEO_TASK_KINDS,
	GEO_TASK_SOURCE_KINDS,
	GEO_TASK_STATES,
	type GeoBatchFacts,
	GeoError,
	type GeoPrincipal,
	type GeoTaskAction,
	type GeoTaskState,
	isHttpUrl,
	principalCan,
	taskGateProblem,
	taskTransition,
	transitionActorOf,
} from "@workspace/geo-domain";
import { db } from "@workspace/lib/db/db";
import type { DbConnection } from "@workspace/lib/db/db-connection";
import {
	geoContentItems,
	geoKnowledgeAssertions,
	geoObservations,
	geoOptimizationTasks,
	geoPromptSets,
	geoPrompts,
	geoSamplingBatches,
	geoSiteAuditFindings,
	geoSitePages,
	geoTaskEvents,
	geoTaskEvidence,
	member,
	user,
} from "@workspace/lib/db/schema";
import { writeGeoAudit } from "@workspace/lib/geo/audit";
import { createOptimizationTask, derivedTaskRisk, type GeoOptimizationTask } from "@workspace/lib/geo/tasks";
import { and, asc, count, desc, eq, ilike, inArray, notInArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { assertContentReleasable } from "./drafts-core";
import { hiddenFromReader } from "./knowledge-shared";
import { compareBatchesFor } from "./metrics-core";

const TERMINAL: readonly GeoTaskState[] = ["VERIFIED", "CANCELLED"];
const LAUNCH_PLAN_LOCKED: readonly GeoTaskState[] = ["PENDING_PUBLISH", "PUBLISHED", "PENDING_RETEST"];
const OWNER_EDITABLE: readonly GeoTaskState[] = ["PENDING_ASSIGNMENT", "IN_PROGRESS", "REJECTED", "PAUSED"];
const BEFORE_PUBLISH: readonly GeoTaskState[] = [
	"PENDING_ANALYSIS",
	"PENDING_ASSIGNMENT",
	"IN_PROGRESS",
	"PENDING_TECH_REVIEW",
	"PENDING_MARKETING_REVIEW",
	"PENDING_PUBLISH",
	"REJECTED",
	"PAUSED",
];

const text = (max: number) => z.string().trim().max(max);
const optionalText = (max: number) => text(max).nullish();

// ---------------------------------------------------------------------------
// Input schemas, shared by the server functions and the REST routes
// ---------------------------------------------------------------------------

export const taskFiltersSchema = z.object({
	state: z.array(z.enum(GEO_TASK_STATES)).optional(),
	ownerId: z.string().max(200).optional(),
	priority: z.enum(GEO_PRIORITIES).optional(),
	kind: z.enum(GEO_TASK_KINDS).optional(),
	promptId: z.string().uuid().optional(),
	q: z.string().trim().max(200).optional(),
});
export type TaskListQuery = z.infer<typeof taskFiltersSchema>;

/** The REST form: `state` arrives as a comma-separated list. */
export const taskListQuerySchema = taskFiltersSchema.extend({
	state: z
		.string()
		.optional()
		.transform((value) => (value ? value.split(",") : undefined))
		.pipe(z.array(z.enum(GEO_TASK_STATES)).optional()),
});

export const createTaskSchema = z.object({
	title: text(200).min(1),
	kind: z.enum(GEO_TASK_KINDS),
	sourceKind: z.enum(GEO_TASK_SOURCE_KINDS),
	sourceRef: optionalText(500),
	priority: z.enum(GEO_PRIORITIES).optional(),
	riskLevel: z.enum(GEO_RISK_LEVELS).optional(),
	promptId: z.string().uuid().nullish(),
	ownerId: z.string().max(200).nullish(),
	recommendedAction: optionalText(4000),
	expectedMetric: optionalText(1000),
	beforeBatchId: z.string().uuid().nullish(),
	evidence: z
		.object({
			observationIds: z.array(z.string().uuid()).max(100).optional(),
			findingIds: z.array(z.string().uuid()).max(100).optional(),
			assertionIds: z.array(z.string().uuid()).max(100).optional(),
		})
		.optional(),
	comment: optionalText(2000),
});
export type CreateTaskInput = z.infer<typeof createTaskSchema>;

export const transitionSchema = z.object({
	action: z.enum(GEO_TASK_ACTIONS),
	comment: optionalText(4000),
	ownerId: z.string().max(200).nullish(),
	publishedUrl: optionalText(2000),
	publishedAt: z.string().datetime({ offset: true }).nullish(),
	proofNote: optionalText(4000),
	proofUrl: optionalText(2000),
	beforeBatchId: z.string().uuid().nullish(),
	afterBatchId: z.string().uuid().nullish(),
});
export type TransitionInput = z.infer<typeof transitionSchema>;

export const updateTaskSchema = z.object({
	title: text(200).min(1).optional(),
	priority: z.enum(GEO_PRIORITIES).optional(),
	riskLevel: z.enum(GEO_RISK_LEVELS).optional(),
	promptId: z.string().uuid().nullish(),
	ownerId: z.string().max(200).nullish(),
	recommendedAction: optionalText(4000),
	expectedMetric: optionalText(1000),
	launchApprovalRef: optionalText(200),
	backupPlan: optionalText(4000),
	rollbackPlan: optionalText(4000),
	beforeBatchId: z.string().uuid().nullish(),
	afterBatchId: z.string().uuid().nullish(),
});
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface TaskSummary {
	id: string;
	title: string;
	kind: GeoOptimizationTask["kind"];
	state: GeoTaskState;
	priority: GeoOptimizationTask["priority"];
	riskLevel: GeoOptimizationTask["riskLevel"];
	ownerId: string | null;
	ownerName: string | null;
	promptQuestion: string | null;
	sourceKind: GeoOptimizationTask["sourceKind"];
	publishedAt: string | null;
	createdAt: string;
	updatedAt: string;
}

function listConditions(organizationId: string, filters: TaskListQuery) {
	const conditions = [eq(geoOptimizationTasks.organizationId, organizationId)];
	if (filters.state?.length) conditions.push(inArray(geoOptimizationTasks.state, filters.state));
	if (filters.ownerId) conditions.push(eq(geoOptimizationTasks.ownerId, filters.ownerId));
	if (filters.priority) conditions.push(eq(geoOptimizationTasks.priority, filters.priority));
	if (filters.kind) conditions.push(eq(geoOptimizationTasks.kind, filters.kind));
	if (filters.promptId) conditions.push(eq(geoOptimizationTasks.promptId, filters.promptId));
	if (filters.q) {
		const like = `%${filters.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
		const match = or(ilike(geoOptimizationTasks.title, like), ilike(geoOptimizationTasks.recommendedAction, like));
		if (match) conditions.push(match);
	}
	return and(...conditions);
}

function summaryQuery() {
	return db
		.select({
			task: geoOptimizationTasks,
			ownerName: user.name,
			promptQuestion: geoPrompts.question,
		})
		.from(geoOptimizationTasks)
		.leftJoin(user, eq(user.id, geoOptimizationTasks.ownerId))
		.leftJoin(geoPrompts, eq(geoPrompts.id, geoOptimizationTasks.promptId));
}

function toSummary(row: { task: GeoOptimizationTask; ownerName: string | null; promptQuestion: string | null }) {
	const { task } = row;
	return {
		id: task.id,
		title: task.title,
		kind: task.kind,
		state: task.state,
		priority: task.priority,
		riskLevel: task.riskLevel,
		ownerId: task.ownerId,
		ownerName: row.ownerName,
		promptQuestion: row.promptQuestion,
		sourceKind: task.sourceKind,
		publishedAt: task.publishedAt?.toISOString() ?? null,
		createdAt: task.createdAt.toISOString(),
		updatedAt: task.updatedAt.toISOString(),
	} satisfies TaskSummary;
}

export async function listTasks(
	principal: GeoPrincipal,
	filters: TaskListQuery,
	paging: { limit: number; offset: number },
): Promise<{ rows: TaskSummary[]; total: number }> {
	assertGeoPermission(principal, "task.read");
	const where = listConditions(principal.organizationId, filters);
	const [{ total }] = await db.select({ total: count() }).from(geoOptimizationTasks).where(where);
	const rows = await summaryQuery()
		.where(where)
		.orderBy(desc(geoOptimizationTasks.updatedAt), desc(geoOptimizationTasks.id))
		.limit(paging.limit)
		.offset(paging.offset);
	return { rows: rows.map(toSummary), total };
}

const BOARD_LIMIT = 300;
const BOARD_TERMINAL_DAYS = 30;

/** Everything still open, plus what closed in the last month, so the board stays bounded. */
export async function listBoardTasks(principal: GeoPrincipal): Promise<{ rows: TaskSummary[]; truncated: boolean }> {
	assertGeoPermission(principal, "task.read");
	const rows = await summaryQuery()
		.where(
			and(
				eq(geoOptimizationTasks.organizationId, principal.organizationId),
				or(
					notInArray(geoOptimizationTasks.state, [...TERMINAL]),
					sql`${geoOptimizationTasks.updatedAt} > now() - make_interval(days => ${BOARD_TERMINAL_DAYS})`,
				),
			),
		)
		.orderBy(asc(geoOptimizationTasks.priority), desc(geoOptimizationTasks.updatedAt))
		.limit(BOARD_LIMIT + 1);
	return { rows: rows.slice(0, BOARD_LIMIT).map(toSummary), truncated: rows.length > BOARD_LIMIT };
}

async function loadTask(tx: DbConnection, organizationId: string, id: string, lock = false) {
	const query = tx
		.select()
		.from(geoOptimizationTasks)
		.where(and(eq(geoOptimizationTasks.organizationId, organizationId), eq(geoOptimizationTasks.id, id)))
		.limit(1);
	const [task] = lock ? await query.for("update") : await query;
	if (!task) throw new GeoError("NOT_FOUND", "工单不存在");
	return task;
}

async function displayNames(ids: string[]): Promise<Record<string, string>> {
	const userIds = [...new Set(ids)].filter((id) => !id.includes(":") && id !== "instance-admin");
	if (userIds.length === 0) return {};
	const rows = await db.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, userIds));
	return Object.fromEntries(rows.map((row) => [row.id, row.name]));
}

async function batchSummaries(organizationId: string, ids: (string | null)[]) {
	const wanted = ids.filter((id): id is string => Boolean(id));
	if (wanted.length === 0) return [];
	return db
		.select({
			id: geoSamplingBatches.id,
			status: geoSamplingBatches.status,
			createdAt: geoSamplingBatches.createdAt,
			promptSetId: geoSamplingBatches.promptSetId,
			promptSetName: geoPromptSets.name,
			promptSetVersion: geoPromptSets.version,
			plannedCount: geoSamplingBatches.plannedCount,
			validCount: geoSamplingBatches.validCount,
		})
		.from(geoSamplingBatches)
		.innerJoin(geoPromptSets, eq(geoPromptSets.id, geoSamplingBatches.promptSetId))
		.where(and(eq(geoSamplingBatches.organizationId, organizationId), inArray(geoSamplingBatches.id, wanted)));
}

/**
 * Read with the same rules as the insights comparison. Null for a caller who may not
 * read metrics, and for batches that cannot be compared under the same conditions
 * (the comparison endpoint names the reason).
 */
async function retestComparison(
	principal: GeoPrincipal,
	task: { beforeBatchId: string | null; afterBatchId: string | null; promptId: string | null },
) {
	if (!task.beforeBatchId || !task.afterBatchId || !principalCan(principal, "metric.read")) return null;
	try {
		return await compareBatchesFor(principal, {
			before: task.beforeBatchId,
			after: task.afterBatchId,
			promptId: task.promptId ?? undefined,
		});
	} catch (error) {
		if (error instanceof GeoError && error.code === "VALIDATION_ERROR") return null;
		throw error;
	}
}

export async function getTaskDetail(principal: GeoPrincipal, id: string) {
	assertGeoPermission(principal, "task.read");
	const { organizationId } = principal;
	const task = await loadTask(db, organizationId, id);

	const [events, evidence, content, prompt, batches] = await Promise.all([
		db
			.select()
			.from(geoTaskEvents)
			.where(and(eq(geoTaskEvents.organizationId, organizationId), eq(geoTaskEvents.taskId, id)))
			.orderBy(asc(geoTaskEvents.createdAt)),
		db
			.select({
				id: geoTaskEvidence.id,
				observationId: geoTaskEvidence.observationId,
				findingId: geoTaskEvidence.findingId,
				assertionId: geoTaskEvidence.assertionId,
				observationQuestion: geoObservations.questionText,
				observationPlatform: geoObservations.platform,
				observationSurfaceMode: geoObservations.surfaceMode,
				observationStatus: geoObservations.status,
				observationSampledAt: geoObservations.sampledAt,
				findingRuleId: geoSiteAuditFindings.ruleId,
				findingSeverity: geoSiteAuditFindings.severity,
				findingRecommendation: geoSiteAuditFindings.recommendation,
				findingPageUrl: geoSitePages.normalizedUrl,
				assertionClaim: geoKnowledgeAssertions.claimText,
				assertionScope: geoKnowledgeAssertions.publicationScope,
				assertionStatus: geoKnowledgeAssertions.status,
			})
			.from(geoTaskEvidence)
			.leftJoin(geoObservations, eq(geoObservations.id, geoTaskEvidence.observationId))
			.leftJoin(geoSiteAuditFindings, eq(geoSiteAuditFindings.id, geoTaskEvidence.findingId))
			.leftJoin(geoSitePages, eq(geoSitePages.id, geoSiteAuditFindings.pageId))
			.leftJoin(geoKnowledgeAssertions, eq(geoKnowledgeAssertions.id, geoTaskEvidence.assertionId))
			.where(and(eq(geoTaskEvidence.organizationId, organizationId), eq(geoTaskEvidence.taskId, id))),
		db
			.select({
				id: geoContentItems.id,
				title: geoContentItems.title,
				kind: geoContentItems.kind,
				approvalState: geoContentItems.approvalState,
				currentVersion: geoContentItems.currentVersion,
				updatedAt: geoContentItems.updatedAt,
			})
			.from(geoContentItems)
			.where(and(eq(geoContentItems.organizationId, organizationId), eq(geoContentItems.taskId, id))),
		task.promptId
			? db
					.select({ id: geoPrompts.id, question: geoPrompts.question })
					.from(geoPrompts)
					.where(eq(geoPrompts.id, task.promptId))
					.limit(1)
			: Promise.resolve([]),
		batchSummaries(organizationId, [task.beforeBatchId, task.afterBatchId]),
	]);

	const names = await displayNames([
		task.createdBy,
		...(task.ownerId ? [task.ownerId] : []),
		...events.map((event) => event.actorId),
	]);
	const comparison = await retestComparison(principal, task);
	const batchOf = (batchId: string | null) => batches.find((batch) => batch.id === batchId) ?? null;

	return {
		task: {
			...task,
			createdAt: task.createdAt.toISOString(),
			updatedAt: task.updatedAt.toISOString(),
			publishedAt: task.publishedAt?.toISOString() ?? null,
			proof: (task.proof ?? null) as TaskProof | null,
		},
		prompt: prompt[0] ?? null,
		names,
		events: events.map((event) => ({ ...event, createdAt: event.createdAt.toISOString() })),
		evidence: evidence.map(({ assertionScope, ...row }) => ({
			...row,
			assertionClaim: hiddenFromReader(principal, assertionScope) ? null : row.assertionClaim,
			observationSampledAt: row.observationSampledAt?.toISOString() ?? null,
		})),
		content: content.map((item) => ({ ...item, updatedAt: item.updatedAt.toISOString() })),
		beforeBatch: serializeBatch(batchOf(task.beforeBatchId)),
		afterBatch: serializeBatch(batchOf(task.afterBatchId)),
		comparison,
		retestRounds: events.filter((event) => event.action === "REQUEST_RETEST").length,
	};
}

function serializeBatch(batch: Awaited<ReturnType<typeof batchSummaries>>[number] | null) {
	return batch ? { ...batch, createdAt: batch.createdAt.toISOString() } : null;
}

export type TaskDetail = Awaited<ReturnType<typeof getTaskDetail>>;

export interface TaskProof {
	note: string;
	url: string | null;
	recordedBy: string;
	recordedAt: string;
}

/** Batches a task can point at for its baseline or its retest. */
export async function listTaskBatches(principal: GeoPrincipal) {
	assertGeoPermission(principal, "task.read");
	const rows = await db
		.select({
			id: geoSamplingBatches.id,
			status: geoSamplingBatches.status,
			createdAt: geoSamplingBatches.createdAt,
			promptSetId: geoSamplingBatches.promptSetId,
			promptSetName: geoPromptSets.name,
			promptSetVersion: geoPromptSets.version,
			plannedCount: geoSamplingBatches.plannedCount,
			validCount: geoSamplingBatches.validCount,
		})
		.from(geoSamplingBatches)
		.innerJoin(geoPromptSets, eq(geoPromptSets.id, geoSamplingBatches.promptSetId))
		.where(eq(geoSamplingBatches.organizationId, principal.organizationId))
		.orderBy(desc(geoSamplingBatches.createdAt))
		.limit(100);
	return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
}

/** Names only: picking an owner should not hand every operator the member list's emails. */
export async function listAssignees(principal: GeoPrincipal) {
	assertGeoPermission(principal, "task.read");
	return db
		.select({ id: user.id, name: user.name })
		.from(member)
		.innerJoin(user, eq(user.id, member.userId))
		.where(eq(member.organizationId, principal.organizationId))
		.orderBy(asc(user.name));
}

export async function listPromptChoices(principal: GeoPrincipal) {
	assertGeoPermission(principal, "task.read");
	return db
		.select({ id: geoPrompts.id, question: geoPrompts.question })
		.from(geoPrompts)
		.where(and(eq(geoPrompts.organizationId, principal.organizationId), notInArray(geoPrompts.status, ["REJECTED"])))
		.orderBy(asc(geoPrompts.question))
		.limit(500);
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

async function assertMember(tx: DbConnection, organizationId: string, userId: string): Promise<void> {
	const [row] = await tx
		.select({ id: member.id })
		.from(member)
		.where(and(eq(member.organizationId, organizationId), eq(member.userId, userId)))
		.limit(1);
	if (!row) throw new GeoError("VALIDATION_ERROR", "责任人必须是本组织成员");
}

async function batchFacts(tx: DbConnection, organizationId: string, id: string | null): Promise<GeoBatchFacts | null> {
	if (!id) return null;
	const [row] = await tx
		.select({
			id: geoSamplingBatches.id,
			promptSetId: geoSamplingBatches.promptSetId,
			createdAt: geoSamplingBatches.createdAt,
			status: geoSamplingBatches.status,
		})
		.from(geoSamplingBatches)
		.where(and(eq(geoSamplingBatches.organizationId, organizationId), eq(geoSamplingBatches.id, id)))
		.limit(1);
	if (!row) throw new GeoError("NOT_FOUND", "采样批次不存在或不属于当前组织");
	return row;
}

async function recordEvent(
	tx: DbConnection,
	principal: GeoPrincipal,
	task: GeoOptimizationTask,
	event: { from: GeoTaskState; to: GeoTaskState; action: string; comment?: string | null; ownerChanged?: boolean },
) {
	await tx.insert(geoTaskEvents).values({
		organizationId: principal.organizationId,
		taskId: task.id,
		fromState: event.from,
		toState: event.to,
		action: event.action,
		actorId: principal.actorId,
		ownerId: event.ownerChanged ? task.ownerId : null,
		comment: event.comment ?? null,
	});
}

async function currentTaskRisk(tx: DbConnection, organizationId: string, task: GeoOptimizationTask) {
	return task.riskLevel === "HIGH" ? task.riskLevel : derivedTaskRisk(tx, organizationId, task.id);
}

/** Past owners, and who approved the current technical review; the state machine compares reviewers with both. */
async function reviewHistory(tx: DbConnection, organizationId: string, taskId: string) {
	const events = await tx
		.select({ action: geoTaskEvents.action, actorId: geoTaskEvents.actorId, ownerId: geoTaskEvents.ownerId })
		.from(geoTaskEvents)
		.where(and(eq(geoTaskEvents.organizationId, organizationId), eq(geoTaskEvents.taskId, taskId)))
		.orderBy(desc(geoTaskEvents.createdAt));
	return {
		pastOwnerIds: events.map((event) => event.ownerId).filter((id): id is string => id !== null),
		techApproverId: events.find((event) => event.action === "APPROVE_TECH")?.actorId ?? null,
	};
}

export async function createTask(principal: GeoPrincipal, input: CreateTaskInput) {
	return db.transaction(async (tx) => {
		if (input.ownerId) await assertMember(tx, principal.organizationId, input.ownerId);
		return createOptimizationTask(tx, principal, {
			...input,
			sourceRef: input.sourceRef ?? null,
			comment: input.comment ?? null,
		});
	});
}

function publishFields(principal: GeoPrincipal, input: TransitionInput) {
	const publishedAt = input.publishedAt ? new Date(input.publishedAt) : null;
	const proof: TaskProof | null = input.proofNote
		? {
				note: input.proofNote,
				url: input.proofUrl || null,
				recordedBy: principal.actorId,
				recordedAt: new Date().toISOString(),
			}
		: null;
	if (proof?.url && !isHttpUrl(proof.url)) throw new GeoError("VALIDATION_ERROR", "证明链接必须是 http 或 https 地址");
	return { publishedAt, proof };
}

function changesFor(
	task: GeoOptimizationTask,
	action: GeoTaskAction,
	to: GeoTaskState,
	input: TransitionInput,
	published: ReturnType<typeof publishFields>,
): Partial<typeof geoOptimizationTasks.$inferInsert> {
	const changes: Partial<typeof geoOptimizationTasks.$inferInsert> = { state: to };
	switch (action) {
		case "ASSIGN":
			changes.ownerId = input.ownerId ?? task.ownerId;
			break;
		case "PAUSE":
			changes.pausedFrom = task.state;
			break;
		case "RESUME":
			changes.pausedFrom = null;
			break;
		case "PUBLISH":
			changes.publishedUrl = input.publishedUrl ?? null;
			changes.publishedAt = published.publishedAt;
			changes.proof = published.proof;
			break;
		case "VERIFY":
			changes.beforeBatchId = input.beforeBatchId ?? task.beforeBatchId;
			changes.afterBatchId = input.afterBatchId ?? task.afterBatchId;
			break;
		case "REOPEN":
			// The next round of rework is retested against a fresh batch.
			changes.afterBatchId = null;
			break;
	}
	return changes;
}

function eventComment(action: GeoTaskAction, input: TransitionInput): string | null {
	if (action === "PUBLISH") {
		return [`发布 URL：${input.publishedUrl ?? ""}`, input.proofNote ? `凭证：${input.proofNote}` : null, input.comment]
			.filter(Boolean)
			.join("\n");
	}
	return input.comment ?? null;
}

export async function transitionTask(principal: GeoPrincipal, id: string, input: TransitionInput) {
	return db.transaction(async (tx) => {
		const task = await loadTask(tx, principal.organizationId, id, true);
		const { action } = input;
		if (action === "ASSIGN" && input.ownerId) await assertMember(tx, principal.organizationId, input.ownerId);
		const published = publishFields(principal, input);
		const riskLevel = await currentTaskRisk(tx, principal.organizationId, task);

		const beforeBatchId = input.beforeBatchId ?? task.beforeBatchId;
		const afterBatchId = input.afterBatchId ?? task.afterBatchId;
		const to = assertGeoTransition(
			taskTransition({
				task: {
					state: task.state,
					kind: task.kind,
					riskLevel,
					authorId: task.createdBy,
					ownerId: task.ownerId,
					...(await reviewHistory(tx, principal.organizationId, task.id)),
					pausedFrom: task.pausedFrom,
				},
				action,
				actor: transitionActorOf(principal),
				payload: {
					comment: input.comment,
					ownerId: input.ownerId,
					publishedUrl: input.publishedUrl,
					proof: published.proof,
					rollbackPlan: task.rollbackPlan,
					beforeBatchId,
					afterBatchId,
				},
			}),
		);

		const linkedContent =
			action === "PUBLISH"
				? await tx
						.select()
						.from(geoContentItems)
						.where(and(eq(geoContentItems.organizationId, principal.organizationId), eq(geoContentItems.taskId, id)))
				: [];
		const problem = taskGateProblem({
			action,
			task: { ...task, riskLevel },
			payload: { publishedUrl: input.publishedUrl, publishedAt: published.publishedAt },
			contentStates: linkedContent.map((item) => item.approvalState),
			before: action === "VERIFY" ? await batchFacts(tx, principal.organizationId, beforeBatchId) : null,
			after: action === "VERIFY" ? await batchFacts(tx, principal.organizationId, afterBatchId) : null,
		});
		if (problem) throw new GeoError(problem.code, problem.message);
		for (const item of linkedContent) await assertContentReleasable(tx, principal, item);

		const [updated] = await tx
			.update(geoOptimizationTasks)
			.set({ ...changesFor(task, action, to, input, published), riskLevel })
			.where(eq(geoOptimizationTasks.id, id))
			.returning();
		await recordEvent(tx, principal, updated, {
			from: task.state,
			to,
			action,
			comment: eventComment(action, input),
			ownerChanged: updated.ownerId !== task.ownerId,
		});
		await writeGeoAudit(tx, {
			principal,
			action: "task.transition",
			entityType: "geo_optimization_task",
			entityId: id,
			before: task,
			after: updated,
			metadata: { action, from: task.state, to },
		});
		return updated;
	});
}

const FIELD_LABELS: Record<keyof UpdateTaskInput, string> = {
	title: "标题",
	priority: "优先级",
	riskLevel: "风险等级",
	promptId: "目标问法",
	ownerId: "责任人",
	recommendedAction: "建议动作",
	expectedMetric: "预期指标",
	launchApprovalRef: "上线审批编号",
	backupPlan: "备份方案",
	rollbackPlan: "回滚计划",
	beforeBatchId: "基线批次",
	afterBatchId: "复测批次",
};

function assertEditable(task: GeoOptimizationTask, input: UpdateTaskInput, changed: (keyof UpdateTaskInput)[]) {
	if (TERMINAL.includes(task.state)) throw new GeoError("CONFLICT", "已结束的工单不能修改");
	if (input.riskLevel === "NORMAL" && task.riskLevel === "HIGH") {
		throw new GeoError("FORBIDDEN", "风险等级只能调高，不能调低");
	}
	const planChanged = changed.some((key) => ["launchApprovalRef", "backupPlan", "rollbackPlan"].includes(key));
	if (planChanged && LAUNCH_PLAN_LOCKED.includes(task.state)) {
		throw new GeoError("CONFLICT", "上线计划已通过审核，进入待发布后不能再修改");
	}
	if (changed.includes("ownerId") && !OWNER_EDITABLE.includes(task.state)) {
		throw new GeoError("CONFLICT", "当前状态不能更换责任人，请先驳回或暂停");
	}
	if (changed.includes("beforeBatchId") && !BEFORE_PUBLISH.includes(task.state)) {
		throw new GeoError("CONFLICT", "发布后不能再更换基线批次");
	}
	if (changed.includes("afterBatchId") && task.state !== "PENDING_RETEST") {
		throw new GeoError("CONFLICT", "只有待复测的工单可以关联复测批次");
	}
}

async function assertUpdateReferences(
	tx: DbConnection,
	organizationId: string,
	input: UpdateTaskInput,
	changed: (keyof UpdateTaskInput)[],
): Promise<void> {
	if (changed.includes("ownerId") && input.ownerId) await assertMember(tx, organizationId, input.ownerId);
	if (changed.includes("promptId") && input.promptId) {
		const [prompt] = await tx
			.select({ id: geoPrompts.id })
			.from(geoPrompts)
			.where(and(eq(geoPrompts.organizationId, organizationId), eq(geoPrompts.id, input.promptId)))
			.limit(1);
		if (!prompt) throw new GeoError("NOT_FOUND", "问法不存在");
	}
	if (changed.includes("beforeBatchId")) await batchFacts(tx, organizationId, input.beforeBatchId ?? null);
	if (changed.includes("afterBatchId")) await batchFacts(tx, organizationId, input.afterBatchId ?? null);
}

export async function updateTask(principal: GeoPrincipal, id: string, input: UpdateTaskInput) {
	assertGeoPermission(principal, "task.transition");
	return db.transaction(async (tx) => {
		const task = await loadTask(tx, principal.organizationId, id, true);
		const changed = (Object.keys(input) as (keyof UpdateTaskInput)[]).filter(
			(key) => input[key] !== undefined && (input[key] ?? null) !== (task[key] ?? null),
		);
		if (changed.length === 0) return task;
		assertEditable(task, input, changed);

		await assertUpdateReferences(tx, principal.organizationId, input, changed);

		const patch = Object.fromEntries(changed.map((key) => [key, input[key] ?? null]));
		const [updated] = await tx
			.update(geoOptimizationTasks)
			.set(patch)
			.where(eq(geoOptimizationTasks.id, id))
			.returning();
		await recordEvent(tx, principal, updated, {
			from: task.state,
			to: task.state,
			action: "UPDATE",
			comment: `修改：${changed.map((key) => FIELD_LABELS[key]).join("、")}`,
			ownerChanged: changed.includes("ownerId"),
		});
		await writeGeoAudit(tx, {
			principal,
			action: "task.update",
			entityType: "geo_optimization_task",
			entityId: id,
			before: task,
			after: updated,
			metadata: { fields: changed },
		});
		return updated;
	});
}
