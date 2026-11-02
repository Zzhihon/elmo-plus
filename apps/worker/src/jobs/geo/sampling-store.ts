import type { CaptureResult } from "@workspace/geo-cn-providers";
import {
	deriveBatchStatus,
	GEO_EVALUATE_OBSERVATION_QUEUE,
	GEO_QUEUE,
	type GeoBatchStatus,
	type GeoEvaluateObservationJob,
	type GeoObservationStatus,
	type GeoRunStatus,
	isEvaluableObservation,
	isTerminalRunStatus,
	samplingSlotKey,
	summarizeBatch,
} from "@workspace/geo-domain";
import { hostOf, normalizeUrl } from "@workspace/geo-evidence";
import { db } from "@workspace/lib/db/db";
import type { DbConnection } from "@workspace/lib/db/db-connection";
import {
	geoObservationCitations,
	geoObservations,
	geoPromptSetItems,
	geoSamplingAttempts,
	geoSamplingBatches,
	geoSamplingRuns,
	geoSamplingTargets,
} from "@workspace/lib/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { getBoss } from "../../boss";

export type SamplingRun = typeof geoSamplingRuns.$inferSelect;
export type SamplingBatch = typeof geoSamplingBatches.$inferSelect;
export type SamplingTarget = typeof geoSamplingTargets.$inferSelect;

export interface RunContext {
	run: SamplingRun;
	batch: SamplingBatch;
	target: SamplingTarget;
	questionText: string;
	promptRevision: number;
}

export async function loadRunContext(organizationId: string, runId: string): Promise<RunContext | null> {
	const [row] = await db
		.select({
			run: geoSamplingRuns,
			batch: geoSamplingBatches,
			target: geoSamplingTargets,
			questionText: geoPromptSetItems.questionText,
			promptRevision: geoPromptSetItems.promptRevision,
		})
		.from(geoSamplingRuns)
		.innerJoin(geoSamplingBatches, eq(geoSamplingBatches.id, geoSamplingRuns.batchId))
		.innerJoin(geoSamplingTargets, eq(geoSamplingTargets.id, geoSamplingRuns.targetId))
		.innerJoin(
			geoPromptSetItems,
			and(
				eq(geoPromptSetItems.setId, geoSamplingBatches.promptSetId),
				eq(geoPromptSetItems.promptId, geoSamplingRuns.promptId),
			),
		)
		.where(and(eq(geoSamplingRuns.id, runId), eq(geoSamplingRuns.organizationId, organizationId)))
		.limit(1);
	return row ?? null;
}

/**
 * One status per planned slot: re-samples collapse onto the slot they repeat, keeping
 * the latest valid run if there is one. That is what keeps a retried or re-sampled job
 * from counting twice in the batch's denominator.
 */
export async function recountBatch(tx: DbConnection, batchId: string): Promise<GeoBatchStatus> {
	// Taken before counting: a run finishing at the same moment then counts only after this
	// transaction commits and sees its result, so the last one to count always sees every run.
	const [batch] = await tx
		.select({ status: geoSamplingBatches.status, startedAt: geoSamplingBatches.startedAt })
		.from(geoSamplingBatches)
		.where(eq(geoSamplingBatches.id, batchId))
		.for("no key update");
	const slots = await tx.execute<{ status: GeoRunStatus }>(sql`
		SELECT status FROM (
			SELECT DISTINCT ON (prompt_id, target_id, repeat_index) status
			FROM ${geoSamplingRuns}
			WHERE batch_id = ${batchId}
			ORDER BY prompt_id, target_id, repeat_index, (status = 'VALID') DESC, created_at DESC
		) slots
	`);
	const counts = summarizeBatch(slots.rows.map((row) => row.status));
	const [cost] = await tx
		.select({ total: sql<string>`coalesce(sum(${geoSamplingAttempts.costEstimate}), 0)` })
		.from(geoSamplingAttempts)
		.innerJoin(geoSamplingRuns, eq(geoSamplingRuns.id, geoSamplingAttempts.runId))
		.where(eq(geoSamplingRuns.batchId, batchId));
	const status = deriveBatchStatus(batch.status, counts);
	const settled = status === "COMPLETED" || status === "PARTIAL" || status === "FAILED";
	await tx
		.update(geoSamplingBatches)
		.set({
			status,
			validCount: counts.valid,
			partialCount: counts.partial,
			unavailableCount: counts.unavailable,
			failedCount: counts.failed,
			costEstimate: cost.total,
			startedAt: batch.startedAt ?? (status === "PLANNED" ? null : sql`now()`),
			finishedAt: settled ? sql`now()` : null,
		})
		.where(eq(geoSamplingBatches.id, batchId));
	return status;
}

export interface Finalization {
	status: Exclude<GeoRunStatus, "PLANNED" | "RUNNING">;
	errorCode?: string | null;
	errorDetail?: string | null;
	capture?: CaptureResult;
	evidenceUri?: string | null;
	sourceMethodVersion?: string | null;
}

function observationValues(
	ctx: RunContext,
	outcome: Finalization,
	attemptCount: number,
	retryOfObservationId: string | null,
) {
	const { run, batch, target } = ctx;
	const capture = outcome.capture;
	const answered = outcome.status === "VALID" || outcome.status === "PARTIAL";
	return {
		organizationId: run.organizationId,
		runId: run.id,
		promptId: run.promptId,
		promptSetId: batch.promptSetId,
		promptRevision: ctx.promptRevision,
		questionText: ctx.questionText,
		targetId: target.id,
		platform: target.platform,
		surfaceMode: target.surfaceMode,
		status: outcome.status as GeoObservationStatus,
		responseText: answered ? (capture?.responseText ?? null) : null,
		sampledAt: capture ? new Date(capture.sampledAt) : new Date(),
		responseMetadata: {
			...capture?.responseMetadata,
			slotKey: samplingSlotKey(run),
			batchId: batch.id,
			attemptCount,
			retryRelation: run.retryRelation,
			providerTraceId: capture?.providerTraceId ?? null,
			costEstimate: capture?.costEstimate ?? null,
			region: target.region,
			language: target.language,
		},
		providerVersion: capture?.providerVersion ?? null,
		modelVersion: capture?.modelVersion ?? null,
		sourceMethodVersion: outcome.sourceMethodVersion ?? null,
		evidenceUri: outcome.evidenceUri ?? null,
		errorCode: outcome.errorCode ?? null,
		retryOfObservationId,
	};
}

async function insertCitations(
	tx: DbConnection,
	organizationId: string,
	observationId: string,
	capture?: CaptureResult,
) {
	if (!capture?.citations?.length) return;
	await tx.insert(geoObservationCitations).values(
		capture.citations.map((citation, ordinal) => ({
			organizationId,
			observationId,
			ordinal,
			url: citation.url,
			normalizedUrl: normalizeUrl(citation.url),
			host: hostOf(citation.url),
			title: citation.title ?? null,
		})),
	);
}

async function previousObservationId(tx: DbConnection, retryOfRunId: string | null): Promise<string | null> {
	if (!retryOfRunId) return null;
	const [row] = await tx
		.select({ id: geoObservations.id })
		.from(geoObservations)
		.where(eq(geoObservations.runId, retryOfRunId))
		.limit(1);
	return row?.id ?? null;
}

/**
 * Ends a run and writes its observation, once. Failures get an observation too, with no
 * answer text and the error code, so the evidence library shows what happened; their
 * status keeps them out of every rate.
 */
export async function finalizeRun(ctx: RunContext, outcome: Finalization): Promise<string | null> {
	const { run, batch } = ctx;
	const answered = outcome.status === "VALID" || outcome.status === "PARTIAL";
	const observationId = await db.transaction(async (tx) => {
		const [locked] = await tx.select().from(geoSamplingRuns).where(eq(geoSamplingRuns.id, run.id)).for("update");
		if (!locked || isTerminalRunStatus(locked.status)) return null;
		const values = observationValues(
			ctx,
			outcome,
			locked.attemptCount,
			await previousObservationId(tx, run.retryOfRunId),
		);
		const [observation] = await tx
			.insert(geoObservations)
			.values(values)
			.onConflictDoNothing({ target: geoObservations.runId })
			.returning({ id: geoObservations.id });
		if (observation && answered) await insertCitations(tx, run.organizationId, observation.id, outcome.capture);

		await tx
			.update(geoSamplingRuns)
			.set({
				status: outcome.status,
				errorCode: outcome.errorCode ?? null,
				errorDetail: outcome.errorDetail ?? null,
				nextAttemptAt: null,
			})
			.where(eq(geoSamplingRuns.id, run.id));
		await recountBatch(tx, batch.id);
		return observation && answered ? observation.id : null;
	});

	if (observationId && isEvaluableObservation(outcome.status as GeoObservationStatus)) {
		await requestEvaluation({ organizationId: run.organizationId, observationId });
	}
	return observationId;
}

/**
 * The evaluation queue belongs to another part of the workspace and may not exist yet;
 * its own sweep picks up observations that were never evaluated, so a failed send is only logged.
 */
export async function requestEvaluation(job: GeoEvaluateObservationJob): Promise<void> {
	try {
		await getBoss().send(GEO_EVALUATE_OBSERVATION_QUEUE, job, { singletonKey: `observation:${job.observationId}` });
	} catch (error) {
		console.warn(
			`[geo-sampling] evaluation not queued for observation ${job.observationId}: ${error instanceof Error ? error.name : "error"}`,
		);
	}
}

/** Puts a run back to PLANNED, due at `dueAt`, and sends the job that will pick it up then. */
export async function scheduleRun(
	organizationId: string,
	runId: string,
	delayMs: number,
	fields: { errorCode?: string | null; errorDetail?: string | null } = {},
): Promise<void> {
	const dueAt = new Date(Date.now() + delayMs);
	await db
		.update(geoSamplingRuns)
		.set({ status: "PLANNED", nextAttemptAt: dueAt, ...fields })
		.where(and(eq(geoSamplingRuns.id, runId), eq(geoSamplingRuns.organizationId, organizationId)));
	await sendCapture(organizationId, runId, delayMs);
}

export async function sendCapture(organizationId: string, runId: string, delayMs = 0): Promise<void> {
	await getBoss().send(
		GEO_QUEUE.samplingCapture,
		{ organizationId, runId },
		delayMs > 0 ? { startAfter: Math.ceil(delayMs / 1000) } : {},
	);
}
