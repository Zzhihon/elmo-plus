import { randomUUID } from "node:crypto";
import { estimatedCostPerRun, isSamplingPlatformEnabled, validateTargetConfig } from "@workspace/geo-cn-providers";
import {
	assertGeoPermission,
	deriveBatchStatus,
	GEO_QUEUE,
	GEO_RUN_STATUSES,
	GeoError,
	type GeoPrincipal,
	type GeoRunStatus,
	isTerminalRunStatus,
	samplingRunIdempotencyKey,
} from "@workspace/geo-domain";
import { db } from "@workspace/lib/db/db";
import type { DbConnection } from "@workspace/lib/db/db-connection";
import {
	geoObservations,
	geoOrgSettings,
	geoPromptSetItems,
	geoPromptSets,
	geoSamplingAttempts,
	geoSamplingBatches,
	geoSamplingRuns,
	geoSamplingTargets,
} from "@workspace/lib/db/schema";
import { writeGeoAudit } from "@workspace/lib/geo/audit";
import { and, asc, count, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { enqueueGeoJob } from "@/lib/geo/enqueue";
import { loadTarget, type SamplingTargetRow } from "./sampling-targets-core";

const MAX_RUNS_PER_BATCH = 5000;
const INSERT_CHUNK = 1000;

export const createBatchInputSchema = z.object({
	promptSetId: z.guid("问法集 ID 无效"),
	targetIds: z.array(z.guid("目标 ID 无效")).min(1, "至少选择一个采样目标").max(50),
	repeatCount: z.number().int().min(1).max(10).default(3),
	/** Extended questions stay out of routine monitoring unless someone explicitly asks for them. */
	includeExtended: z.boolean().default(false),
	idempotencyKey: z.string().trim().min(1).max(200).optional(),
});
export type CreateBatchInput = z.input<typeof createBatchInputSchema>;

export const resampleInputSchema = z.object({ reason: z.string().trim().min(2, "请填写重采原因").max(500) });

type Paging = { page: number; limit: number; offset: number };

export interface FrozenPromptSetView {
	id: string;
	name: string;
	version: number;
	frozenAt: string | null;
	itemCount: number;
	coreCount: number;
	extendedCount: number;
}

/** Only a frozen set is a fixed, comparable question list, so only frozen sets can be sampled. */
export async function listFrozenPromptSets(principal: GeoPrincipal): Promise<FrozenPromptSetView[]> {
	assertGeoPermission(principal, "sampling.read");
	const rows = await db
		.select({
			id: geoPromptSets.id,
			name: geoPromptSets.name,
			version: geoPromptSets.version,
			frozenAt: geoPromptSets.frozenAt,
			itemCount: sql<number>`(select count(*)::int from ${geoPromptSetItems} where ${geoPromptSetItems.setId} = ${geoPromptSets.id})`,
			coreCount: sql<number>`(select count(*)::int from ${geoPromptSetItems} where ${geoPromptSetItems.setId} = ${geoPromptSets.id} and ${geoPromptSetItems.labels}->>'tier' = 'CORE')`,
		})
		.from(geoPromptSets)
		.where(and(eq(geoPromptSets.organizationId, principal.organizationId), eq(geoPromptSets.status, "FROZEN")))
		.orderBy(desc(geoPromptSets.frozenAt));
	return rows.map((row) => ({
		...row,
		frozenAt: row.frozenAt?.toISOString() ?? null,
		extendedCount: row.itemCount - row.coreCount,
	}));
}

const RUNNABLE_VERIFICATION = new Set(["PASSED", "LIMITED"]);

/** The same checks the worker applies before each attempt, applied up front so a batch is never planned against a dead target. */
export function assertTargetRunnable(target: SamplingTargetRow): void {
	const label = `${target.platform}/${target.surfaceMode}`;
	if (target.surfaceMode === "MANUAL_EVIDENCE") {
		throw new GeoError("VALIDATION_ERROR", `${label} 是人工证据目标，请通过“导入证据”采样`);
	}
	if (!target.enabled) throw new GeoError("TARGET_UNAVAILABLE", `${label} 已停用`);
	if (!isSamplingPlatformEnabled(target.platform)) {
		throw new GeoError("TARGET_UNAVAILABLE", `${label} 所属平台的自动采样在部署中未开启`);
	}
	if (!RUNNABLE_VERIFICATION.has(target.verificationStatus)) {
		throw new GeoError("TARGET_UNAVAILABLE", `${label} 未通过数据源验证，不能发起自动采样`);
	}
	const config = validateTargetConfig(target.surfaceMode, target.config, target.modelId);
	if (!config.ok) throw new GeoError("TARGET_UNAVAILABLE", `${label} 配置不完整：${config.errors.join("；")}`);
}

async function loadFrozenSet(principal: GeoPrincipal, promptSetId: string, includeExtended: boolean) {
	const [set] = await db
		.select()
		.from(geoPromptSets)
		.where(and(eq(geoPromptSets.id, promptSetId), eq(geoPromptSets.organizationId, principal.organizationId)));
	if (!set) throw new GeoError("NOT_FOUND", "问法集不存在");
	if (set.status !== "FROZEN") throw new GeoError("CONFLICT", "只能对已冻结的问法集发起采样");
	const items = await db
		.select({ promptId: geoPromptSetItems.promptId, labels: geoPromptSetItems.labels })
		.from(geoPromptSetItems)
		.where(eq(geoPromptSetItems.setId, set.id))
		.orderBy(asc(geoPromptSetItems.createdAt));
	if (items.length === 0) throw new GeoError("VALIDATION_ERROR", "问法集为空");
	const chosen = includeExtended ? items : items.filter((item) => item.labels.tier === "CORE");
	if (chosen.length === 0) {
		throw new GeoError("VALIDATION_ERROR", "问法集中没有核心问法；如需采样扩展问法，请明确选择包含扩展问法");
	}
	return { set, promptIds: chosen.map((item) => item.promptId) };
}

/** What started runs have not yet recorded and planned runs have not yet spent, as if each costs its estimate. */
async function reservedCost(tx: DbConnection, organizationId: string): Promise<number> {
	const rows = await tx
		.select({
			surfaceMode: geoSamplingTargets.surfaceMode,
			config: geoSamplingTargets.config,
			runs: count(),
		})
		.from(geoSamplingRuns)
		.innerJoin(geoSamplingTargets, eq(geoSamplingTargets.id, geoSamplingRuns.targetId))
		.where(
			and(eq(geoSamplingRuns.organizationId, organizationId), inArray(geoSamplingRuns.status, ["PLANNED", "RUNNING"])),
		)
		.groupBy(geoSamplingTargets.id);
	return rows.reduce((sum, row) => sum + estimatedCostPerRun(row.surfaceMode, row.config) * row.runs, 0);
}

/** Org-wide limits from settings: runs per batch, runs per rolling day, and estimated cost per rolling 30 days. */
async function assertWithinOrgLimits(
	tx: DbConnection,
	principal: GeoPrincipal,
	planned: number,
	estimatedCost: number,
): Promise<void> {
	const [settings] = await tx
		.select()
		.from(geoOrgSettings)
		.where(eq(geoOrgSettings.organizationId, principal.organizationId));
	if (!settings) return;
	if (settings.samplingBatchLimit !== null && planned > settings.samplingBatchLimit) {
		throw new GeoError("RATE_LIMITED", `本批次计划 ${planned} 次，超过单批上限 ${settings.samplingBatchLimit}`);
	}
	if (settings.samplingDailyLimit !== null) {
		const [today] = await tx
			.select({ value: count() })
			.from(geoSamplingRuns)
			.where(
				and(
					eq(geoSamplingRuns.organizationId, principal.organizationId),
					gt(geoSamplingRuns.createdAt, new Date(Date.now() - 86_400_000)),
				),
			);
		if (today.value + planned > settings.samplingDailyLimit) {
			throw new GeoError(
				"RATE_LIMITED",
				`近 24 小时已计划 ${today.value} 次，再加本批 ${planned} 次将超过每日上限 ${settings.samplingDailyLimit}`,
			);
		}
	}
	if (settings.samplingCostBudget !== null) {
		const [spent] = await tx
			.select({ total: sql<string>`coalesce(sum(${geoSamplingAttempts.costEstimate}), 0)` })
			.from(geoSamplingAttempts)
			.where(
				and(
					eq(geoSamplingAttempts.organizationId, principal.organizationId),
					gt(geoSamplingAttempts.startedAt, new Date(Date.now() - 30 * 86_400_000)),
				),
			);
		const budget = Number(settings.samplingCostBudget);
		const committed = Number(spent.total) + (await reservedCost(tx, principal.organizationId));
		if (committed + estimatedCost > budget) {
			throw new GeoError("RATE_LIMITED", `预计费用将超过近 30 天采样成本预算 ${budget}`);
		}
	}
}

export type BatchRow = typeof geoSamplingBatches.$inferSelect;

export interface CreateBatchResult {
	batch: BatchRow;
	created: boolean;
	jobId: string | null;
	estimatedCost: number;
}

async function requestDispatch(organizationId: string, batchId: string): Promise<string | null> {
	try {
		return await enqueueGeoJob(
			GEO_QUEUE.samplingDispatch,
			{ organizationId, batchId },
			{ singletonKey: `batch:${batchId}` },
		);
	} catch (error) {
		// The batch is committed; the worker's sweep starts any run whose job never arrived.
		console.warn(
			`[geo-sampling] dispatch not queued for batch ${batchId}: ${error instanceof Error ? error.message : "error"}`,
		);
		return null;
	}
}

/**
 * Plans frozen question set × targets × repeats as one PLANNED run per slot, each with the
 * key batch+prompt+target+repeat, after the compliance and quota checks. Sending the same
 * idempotency key again returns the batch already planned instead of a second one.
 */
export async function createSamplingBatch(
	principal: GeoPrincipal,
	input: CreateBatchInput,
	headerKey?: string | null,
): Promise<CreateBatchResult> {
	assertGeoPermission(principal, "sampling.run");
	const idempotencyKey = input.idempotencyKey ?? headerKey ?? randomUUID();
	const [existing] = await db
		.select()
		.from(geoSamplingBatches)
		.where(
			and(
				eq(geoSamplingBatches.organizationId, principal.organizationId),
				eq(geoSamplingBatches.idempotencyKey, idempotencyKey),
			),
		);
	if (existing)
		return { batch: existing, created: false, jobId: null, estimatedCost: Number(existing.costEstimate ?? 0) };

	const includeExtended = input.includeExtended ?? false;
	const repeatCount = input.repeatCount ?? 3;
	const { set, promptIds } = await loadFrozenSet(principal, input.promptSetId, includeExtended);
	const targetIds = [...new Set(input.targetIds)];
	const targets = await Promise.all(targetIds.map((id) => loadTarget(principal, id)));
	for (const target of targets) assertTargetRunnable(target);

	const planned = promptIds.length * targets.length * repeatCount;
	if (planned > MAX_RUNS_PER_BATCH) {
		throw new GeoError("VALIDATION_ERROR", `本批次计划 ${planned} 次，超过系统上限 ${MAX_RUNS_PER_BATCH}`);
	}
	const estimatedCost = targets.reduce(
		(sum, target) => sum + estimatedCostPerRun(target.surfaceMode, target.config) * promptIds.length * repeatCount,
		0,
	);

	const batch = await db.transaction(async (tx) => {
		// Limits are checked against what earlier batches planned, so two at once must take turns.
		await tx.execute(
			sql`select pg_advisory_xact_lock(hashtextextended(${`geo-sampling-plan:${principal.organizationId}`}, 0))`,
		);
		const [duplicate] = await tx
			.select({ id: geoSamplingBatches.id })
			.from(geoSamplingBatches)
			.where(
				and(
					eq(geoSamplingBatches.organizationId, principal.organizationId),
					eq(geoSamplingBatches.idempotencyKey, idempotencyKey),
				),
			);
		if (duplicate) return null;
		await assertWithinOrgLimits(tx, principal, planned, estimatedCost);
		const [row] = await tx
			.insert(geoSamplingBatches)
			.values({
				organizationId: principal.organizationId,
				promptSetId: set.id,
				repeatCount,
				includesExtended: includeExtended,
				plannedCount: planned,
				costEstimate: "0",
				requestedBy: principal.actorId,
				idempotencyKey,
			})
			.onConflictDoNothing({ target: [geoSamplingBatches.organizationId, geoSamplingBatches.idempotencyKey] })
			.returning();
		if (!row) return null;
		const runs = promptIds.flatMap((promptId) =>
			targets.flatMap((target) =>
				Array.from({ length: repeatCount }, (_, repeatIndex) => ({
					organizationId: principal.organizationId,
					batchId: row.id,
					promptId,
					targetId: target.id,
					repeatIndex,
					idempotencyKey: samplingRunIdempotencyKey({ batchId: row.id, promptId, targetId: target.id, repeatIndex }),
				})),
			),
		);
		for (let i = 0; i < runs.length; i += INSERT_CHUNK) {
			await tx
				.insert(geoSamplingRuns)
				.values(runs.slice(i, i + INSERT_CHUNK))
				.onConflictDoNothing({ target: geoSamplingRuns.idempotencyKey });
		}
		await writeGeoAudit(tx, {
			principal,
			action: "sampling.batch.create",
			entityType: "sampling_batch",
			entityId: row.id,
			after: row,
			metadata: {
				promptSetId: set.id,
				promptSetVersion: set.version,
				targetIds,
				repeatCount,
				includeExtended,
				planned,
				estimatedCost,
			},
		});
		return row;
	});
	if (!batch) return createSamplingBatch(principal, { ...input, idempotencyKey }, headerKey);
	const jobId = await requestDispatch(principal.organizationId, batch.id);
	return { batch, created: true, jobId, estimatedCost };
}

export interface BatchListItem {
	id: string;
	status: BatchRow["status"];
	promptSet: { id: string; name: string; version: number };
	repeatCount: number;
	includesExtended: boolean;
	plannedCount: number;
	validCount: number;
	partialCount: number;
	unavailableCount: number;
	failedCount: number;
	costEstimate: number;
	targetCount: number;
	requestedBy: string;
	createdAt: string;
	startedAt: string | null;
	finishedAt: string | null;
}

function toListItem(
	row: BatchRow,
	set: { id: string; name: string; version: number },
	targetCount: number,
): BatchListItem {
	return {
		id: row.id,
		status: row.status,
		promptSet: set,
		repeatCount: row.repeatCount,
		includesExtended: row.includesExtended,
		plannedCount: row.plannedCount,
		validCount: row.validCount,
		partialCount: row.partialCount,
		unavailableCount: row.unavailableCount,
		failedCount: row.failedCount,
		costEstimate: Number(row.costEstimate ?? 0),
		targetCount,
		requestedBy: row.requestedBy,
		createdAt: row.createdAt.toISOString(),
		startedAt: row.startedAt?.toISOString() ?? null,
		finishedAt: row.finishedAt?.toISOString() ?? null,
	};
}

export async function listSamplingBatches(
	principal: GeoPrincipal,
	paging: Paging,
): Promise<{ rows: BatchListItem[]; total: number }> {
	assertGeoPermission(principal, "sampling.read");
	const where = eq(geoSamplingBatches.organizationId, principal.organizationId);
	const [rows, [total]] = await Promise.all([
		db
			.select({
				batch: geoSamplingBatches,
				set: { id: geoPromptSets.id, name: geoPromptSets.name, version: geoPromptSets.version },
				targetCount: sql<number>`(select count(distinct ${geoSamplingRuns.targetId})::int from ${geoSamplingRuns} where ${geoSamplingRuns.batchId} = ${geoSamplingBatches.id})`,
			})
			.from(geoSamplingBatches)
			.innerJoin(geoPromptSets, eq(geoPromptSets.id, geoSamplingBatches.promptSetId))
			.where(where)
			.orderBy(desc(geoSamplingBatches.createdAt))
			.limit(paging.limit)
			.offset(paging.offset),
		db.select({ value: count() }).from(geoSamplingBatches).where(where),
	]);
	return { rows: rows.map((row) => toListItem(row.batch, row.set, row.targetCount)), total: total.value };
}

export interface BatchTargetBreakdown {
	targetId: string;
	platform: SamplingTargetRow["platform"];
	surfaceMode: SamplingTargetRow["surfaceMode"];
	provider: string;
	modelId: string | null;
	verificationStatus: SamplingTargetRow["verificationStatus"];
	statuses: Partial<Record<GeoRunStatus, number>>;
}

export interface BatchRunView {
	id: string;
	promptId: string;
	questionText: string;
	targetId: string;
	platform: SamplingTargetRow["platform"];
	surfaceMode: SamplingTargetRow["surfaceMode"];
	repeatIndex: number;
	status: GeoRunStatus;
	attemptCount: number;
	errorCode: string | null;
	errorDetail: string | null;
	retryOfRunId: string | null;
	retryRelation: string | null;
	nextAttemptAt: string | null;
	observationId: string | null;
	updatedAt: string;
}

export interface BatchDetail extends BatchListItem {
	idempotencyKey: string;
	targets: BatchTargetBreakdown[];
	runs: BatchRunView[];
	runTotal: number;
}

export const batchRunsQuerySchema = z.object({
	status: z.enum(GEO_RUN_STATUSES).optional(),
	targetId: z.guid().optional(),
});

export async function getSamplingBatch(
	principal: GeoPrincipal,
	batchId: string,
	paging: Paging,
	filters: z.infer<typeof batchRunsQuerySchema> = {},
): Promise<BatchDetail> {
	assertGeoPermission(principal, "sampling.read");
	const [row] = await db
		.select({
			batch: geoSamplingBatches,
			set: { id: geoPromptSets.id, name: geoPromptSets.name, version: geoPromptSets.version },
		})
		.from(geoSamplingBatches)
		.innerJoin(geoPromptSets, eq(geoPromptSets.id, geoSamplingBatches.promptSetId))
		.where(and(eq(geoSamplingBatches.id, batchId), eq(geoSamplingBatches.organizationId, principal.organizationId)));
	if (!row) throw new GeoError("NOT_FOUND", "采样批次不存在");

	const breakdown = await db
		.select({
			targetId: geoSamplingTargets.id,
			platform: geoSamplingTargets.platform,
			surfaceMode: geoSamplingTargets.surfaceMode,
			provider: geoSamplingTargets.provider,
			modelId: geoSamplingTargets.modelId,
			verificationStatus: geoSamplingTargets.verificationStatus,
			status: geoSamplingRuns.status,
			value: count(),
		})
		.from(geoSamplingRuns)
		.innerJoin(geoSamplingTargets, eq(geoSamplingTargets.id, geoSamplingRuns.targetId))
		.where(eq(geoSamplingRuns.batchId, batchId))
		.groupBy(geoSamplingTargets.id, geoSamplingRuns.status);
	const targets = new Map<string, BatchTargetBreakdown>();
	for (const item of breakdown) {
		const entry = targets.get(item.targetId) ?? {
			targetId: item.targetId,
			platform: item.platform,
			surfaceMode: item.surfaceMode,
			provider: item.provider,
			modelId: item.modelId,
			verificationStatus: item.verificationStatus,
			statuses: {},
		};
		entry.statuses[item.status] = item.value;
		targets.set(item.targetId, entry);
	}

	const runWhere = and(
		eq(geoSamplingRuns.batchId, batchId),
		filters.status ? eq(geoSamplingRuns.status, filters.status) : undefined,
		filters.targetId ? eq(geoSamplingRuns.targetId, filters.targetId) : undefined,
	);
	const [runs, [runTotal]] = await Promise.all([
		db
			.select({
				run: geoSamplingRuns,
				questionText: geoPromptSetItems.questionText,
				platform: geoSamplingTargets.platform,
				surfaceMode: geoSamplingTargets.surfaceMode,
				observationId: geoObservations.id,
			})
			.from(geoSamplingRuns)
			.innerJoin(geoSamplingTargets, eq(geoSamplingTargets.id, geoSamplingRuns.targetId))
			.innerJoin(
				geoPromptSetItems,
				and(
					eq(geoPromptSetItems.setId, row.batch.promptSetId),
					eq(geoPromptSetItems.promptId, geoSamplingRuns.promptId),
				),
			)
			.leftJoin(geoObservations, eq(geoObservations.runId, geoSamplingRuns.id))
			.where(runWhere)
			.orderBy(
				asc(geoPromptSetItems.createdAt),
				asc(geoSamplingTargets.platform),
				asc(geoSamplingRuns.repeatIndex),
				asc(geoSamplingRuns.createdAt),
			)
			.limit(paging.limit)
			.offset(paging.offset),
		db.select({ value: count() }).from(geoSamplingRuns).where(runWhere),
	]);

	return {
		...toListItem(row.batch, row.set, targets.size),
		idempotencyKey: row.batch.idempotencyKey,
		targets: [...targets.values()],
		runs: runs.map((item) => ({
			id: item.run.id,
			promptId: item.run.promptId,
			questionText: item.questionText,
			targetId: item.run.targetId,
			platform: item.platform,
			surfaceMode: item.surfaceMode,
			repeatIndex: item.run.repeatIndex,
			status: item.run.status,
			attemptCount: item.run.attemptCount,
			errorCode: item.run.errorCode,
			errorDetail: item.run.errorDetail,
			retryOfRunId: item.run.retryOfRunId,
			retryRelation: item.run.retryRelation,
			nextAttemptAt: item.run.nextAttemptAt?.toISOString() ?? null,
			observationId: item.observationId,
			updatedAt: item.run.updatedAt.toISOString(),
		})),
		runTotal: runTotal.value,
	};
}

async function loadBatchForUpdate(principal: GeoPrincipal, batchId: string) {
	const [batch] = await db
		.select()
		.from(geoSamplingBatches)
		.where(and(eq(geoSamplingBatches.id, batchId), eq(geoSamplingBatches.organizationId, principal.organizationId)));
	if (!batch) throw new GeoError("NOT_FOUND", "采样批次不存在");
	return batch;
}

/** Runs already in flight finish; nothing new starts until the batch is resumed. */
export async function pauseSamplingBatch(principal: GeoPrincipal, batchId: string): Promise<BatchRow> {
	assertGeoPermission(principal, "sampling.run");
	const before = await loadBatchForUpdate(principal, batchId);
	if (before.status !== "PLANNED" && before.status !== "RUNNING") {
		throw new GeoError("CONFLICT", "只有计划中或运行中的批次可以暂停");
	}
	return db.transaction(async (tx) => {
		const [after] = await tx
			.update(geoSamplingBatches)
			.set({ status: "PAUSED" })
			.where(and(eq(geoSamplingBatches.id, batchId), inArray(geoSamplingBatches.status, ["PLANNED", "RUNNING"])))
			.returning();
		if (!after) throw new GeoError("CONFLICT", "批次状态已变化，请刷新后重试");
		await writeGeoAudit(tx, {
			principal,
			action: "sampling.batch.pause",
			entityType: "sampling_batch",
			entityId: batchId,
			before,
			after,
		});
		return after;
	});
}

export async function resumeSamplingBatch(principal: GeoPrincipal, batchId: string): Promise<BatchRow> {
	assertGeoPermission(principal, "sampling.run");
	const { after, status } = await db.transaction(async (tx) => {
		// Held like a recount holds it, so runs that finish while this decides are not missed.
		const [before] = await tx
			.select()
			.from(geoSamplingBatches)
			.where(and(eq(geoSamplingBatches.id, batchId), eq(geoSamplingBatches.organizationId, principal.organizationId)))
			.for("no key update");
		if (!before) throw new GeoError("NOT_FOUND", "采样批次不存在");
		if (before.status !== "PAUSED") throw new GeoError("CONFLICT", "只有已暂停的批次可以恢复");
		const pending =
			before.plannedCount - before.validCount - before.partialCount - before.unavailableCount - before.failedCount;
		const status = deriveBatchStatus("RUNNING", {
			planned: before.plannedCount,
			valid: before.validCount,
			partial: before.partialCount,
			unavailable: before.unavailableCount,
			failed: before.failedCount,
			pending: Math.max(0, pending),
		});
		const [row] = await tx
			.update(geoSamplingBatches)
			.set({ status, finishedAt: status === "RUNNING" ? null : sql`now()` })
			.where(eq(geoSamplingBatches.id, batchId))
			.returning();
		await writeGeoAudit(tx, {
			principal,
			action: "sampling.batch.resume",
			entityType: "sampling_batch",
			entityId: batchId,
			before,
			after: row,
		});
		return { after: row, status };
	});
	if (status === "RUNNING") await requestDispatch(principal.organizationId, batchId);
	return after;
}

/**
 * An explicit re-sample is a new run on the same slot, linked by `retry_of_run_id`, and
 * produces a new observation that points at the old one. The original is never touched,
 * and the slot still counts once.
 */
export async function resampleRun(
	principal: GeoPrincipal,
	runId: string,
	input: z.infer<typeof resampleInputSchema>,
): Promise<{ runId: string }> {
	assertGeoPermission(principal, "sampling.run");
	const [run] = await db
		.select()
		.from(geoSamplingRuns)
		.where(and(eq(geoSamplingRuns.id, runId), eq(geoSamplingRuns.organizationId, principal.organizationId)));
	if (!run) throw new GeoError("NOT_FOUND", "采样运行不存在");
	if (!isTerminalRunStatus(run.status)) throw new GeoError("CONFLICT", "该运行尚未结束，不能重采");
	assertTargetRunnable(await loadTarget(principal, run.targetId));

	const idempotencyKey = samplingRunIdempotencyKey({ ...run, resampleOf: run.id });
	const created = await db.transaction(async (tx) => {
		const [row] = await tx
			.insert(geoSamplingRuns)
			.values({
				organizationId: principal.organizationId,
				batchId: run.batchId,
				promptId: run.promptId,
				targetId: run.targetId,
				repeatIndex: run.repeatIndex,
				idempotencyKey,
				retryOfRunId: run.id,
				retryRelation: "EXPLICIT_RESAMPLE",
			})
			.onConflictDoNothing({ target: geoSamplingRuns.idempotencyKey })
			.returning();
		if (!row) throw new GeoError("CONFLICT", "该运行已经发起过重采，请在最新一次重采上操作");
		await tx
			.update(geoSamplingBatches)
			.set({ status: "RUNNING", finishedAt: null })
			.where(
				and(
					eq(geoSamplingBatches.id, run.batchId),
					inArray(geoSamplingBatches.status, ["COMPLETED", "PARTIAL", "FAILED"]),
				),
			);
		await writeGeoAudit(tx, {
			principal,
			action: "sampling.run.resample",
			entityType: "sampling_run",
			entityId: row.id,
			after: row,
			metadata: { retryOfRunId: run.id, reason: input.reason },
		});
		return row;
	});
	try {
		await enqueueGeoJob(GEO_QUEUE.samplingCapture, { organizationId: principal.organizationId, runId: created.id });
	} catch (error) {
		console.warn(
			`[geo-sampling] re-sample ${created.id} not queued: ${error instanceof Error ? error.message : "error"}`,
		);
	}
	return { runId: created.id };
}
