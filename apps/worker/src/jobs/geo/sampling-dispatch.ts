import { captureFailure, decideRetry, resolveRetryPolicy } from "@workspace/geo-cn-providers";
import { GEO_QUEUE } from "@workspace/geo-domain";
import { db } from "@workspace/lib/db/db";
import { geoSamplingAttempts, geoSamplingBatches, geoSamplingRuns, geoSamplingTargets } from "@workspace/lib/db/schema";
import { and, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { getBoss } from "../../boss";
import { STALE_ATTEMPT_MS } from "./sampling-capture";
import { finalizeRun, loadRunContext, recountBatch, scheduleRun } from "./sampling-store";

export interface DispatchJobData {
	organizationId?: string;
	batchId?: string;
}

const SEND_CHUNK = 500;
/** A PLANNED run this far past due has lost its job. */
const OVERDUE_MS = 3 * 60_000;
const SWEEP_LIMIT = 2000;

async function sendCaptures(runs: { organizationId: string; id: string; nextAttemptAt: Date | null }[], tag: string) {
	const boss = getBoss();
	const now = Date.now();
	for (let i = 0; i < runs.length; i += SEND_CHUNK) {
		await boss.insert(
			GEO_QUEUE.samplingCapture,
			runs.slice(i, i + SEND_CHUNK).map((run) => ({
				data: { organizationId: run.organizationId, runId: run.id },
				startAfter: run.nextAttemptAt && run.nextAttemptAt.getTime() > now ? run.nextAttemptAt : undefined,
				singletonKey: `${tag}:${run.id}`,
				singletonSeconds: 10 * 60,
			})),
		);
	}
}

/** Fans a batch out into one capture job per planned run; each target's own limits then pace them. */
export async function dispatchBatch(organizationId: string, batchId: string): Promise<number> {
	const [batch] = await db
		.select({ status: geoSamplingBatches.status })
		.from(geoSamplingBatches)
		.where(and(eq(geoSamplingBatches.id, batchId), eq(geoSamplingBatches.organizationId, organizationId)));
	if (!batch || batch.status === "PAUSED" || batch.status === "CANCELLED") return 0;

	await db.transaction(async (tx) => {
		await tx
			.update(geoSamplingBatches)
			.set({ status: "RUNNING", startedAt: sql`coalesce(${geoSamplingBatches.startedAt}, now())` })
			.where(and(eq(geoSamplingBatches.id, batchId), eq(geoSamplingBatches.status, "PLANNED")));
	});
	const runs = await db
		.select({
			organizationId: geoSamplingRuns.organizationId,
			id: geoSamplingRuns.id,
			nextAttemptAt: geoSamplingRuns.nextAttemptAt,
		})
		.from(geoSamplingRuns)
		.where(and(eq(geoSamplingRuns.batchId, batchId), eq(geoSamplingRuns.status, "PLANNED")));
	await sendCaptures(runs, "dispatch");
	return runs.length;
}

/**
 * An attempt still RUNNING long after any timeout means its worker died. The attempt is
 * closed as stalled and the run goes through the normal retry decision, so it neither
 * hangs forever nor gets an extra free attempt.
 */
async function recoverStalledRuns(now: Date): Promise<number> {
	const stalled = await db
		.select({
			id: geoSamplingRuns.id,
			organizationId: geoSamplingRuns.organizationId,
			attemptCount: geoSamplingRuns.attemptCount,
			retryPolicy: geoSamplingTargets.retryPolicy,
		})
		.from(geoSamplingRuns)
		.innerJoin(geoSamplingTargets, eq(geoSamplingTargets.id, geoSamplingRuns.targetId))
		.where(
			and(
				eq(geoSamplingRuns.status, "RUNNING"),
				lt(geoSamplingRuns.updatedAt, new Date(now.getTime() - STALE_ATTEMPT_MS)),
			),
		)
		.limit(SWEEP_LIMIT);

	const failure = captureFailure("TIMEOUT", "STALLED", "采样进程中断，尝试未完成");
	for (const run of stalled) {
		const claimed = await db.transaction(async (tx) => {
			const [locked] = await tx
				.select({ status: geoSamplingRuns.status })
				.from(geoSamplingRuns)
				.where(eq(geoSamplingRuns.id, run.id))
				.for("update");
			if (locked?.status !== "RUNNING") return false;
			await tx
				.update(geoSamplingAttempts)
				.set({
					status: "TIMEOUT",
					errorCode: failure.code,
					durationMs: sql`(extract(epoch from (now() - ${geoSamplingAttempts.startedAt})) * 1000)::int`,
				})
				.where(and(eq(geoSamplingAttempts.runId, run.id), eq(geoSamplingAttempts.status, "RUNNING")));
			await tx
				.update(geoSamplingRuns)
				.set({ status: "PLANNED", errorCode: failure.code, errorDetail: failure.message })
				.where(eq(geoSamplingRuns.id, run.id));
			return true;
		});
		if (!claimed) continue;
		const decision = decideRetry(failure, run.attemptCount, resolveRetryPolicy(run.retryPolicy));
		if (decision.retry) {
			await scheduleRun(run.organizationId, run.id, decision.delayMs, {
				errorCode: failure.code,
				errorDetail: failure.message,
			});
			continue;
		}
		const ctx = await loadRunContext(run.organizationId, run.id);
		if (ctx) await finalizeRun(ctx, { status: "TIMEOUT", errorCode: failure.code, errorDetail: failure.message });
	}
	return stalled.length;
}

/** Re-queues runs whose job never arrived: overdue PLANNED runs in batches that are meant to be running. */
async function requeueLostRuns(now: Date): Promise<number> {
	const overdue = new Date(now.getTime() - OVERDUE_MS);
	const lost = await db
		.select({
			organizationId: geoSamplingRuns.organizationId,
			id: geoSamplingRuns.id,
			nextAttemptAt: geoSamplingRuns.nextAttemptAt,
		})
		.from(geoSamplingRuns)
		.innerJoin(geoSamplingBatches, eq(geoSamplingBatches.id, geoSamplingRuns.batchId))
		.where(
			and(
				eq(geoSamplingRuns.status, "PLANNED"),
				inArray(geoSamplingBatches.status, ["PLANNED", "RUNNING", "PARTIAL", "COMPLETED", "FAILED"]),
				or(
					and(isNull(geoSamplingRuns.nextAttemptAt), lt(geoSamplingRuns.updatedAt, overdue)),
					lte(geoSamplingRuns.nextAttemptAt, overdue),
				),
			),
		)
		.limit(SWEEP_LIMIT);
	if (lost.length === 0) return 0;
	await db
		.update(geoSamplingRuns)
		.set({ nextAttemptAt: null })
		.where(
			inArray(
				geoSamplingRuns.id,
				lost.map((run) => run.id),
			),
		);
	await sendCaptures(
		lost.map((run) => ({ ...run, nextAttemptAt: null })),
		"sweep",
	);
	return lost.length;
}

/** Counts again for any batch still marked running with no run left to finish; nothing else would ever close it. */
async function settleFinishedBatches(now: Date): Promise<number> {
	const r = geoSamplingRuns;
	const finished = await db
		.select({ id: geoSamplingBatches.id })
		.from(geoSamplingBatches)
		.where(
			and(
				eq(geoSamplingBatches.status, "RUNNING"),
				lt(geoSamplingBatches.updatedAt, new Date(now.getTime() - OVERDUE_MS)),
				sql`not exists (select 1 from ${r} where ${r.batchId} = ${geoSamplingBatches.id} and ${r.status} in ('PLANNED', 'RUNNING'))`,
			),
		)
		.limit(SWEEP_LIMIT);
	for (const batch of finished) await db.transaction((tx) => recountBatch(tx, batch.id));
	return finished.length;
}

export async function sweepSampling(
	now: Date = new Date(),
): Promise<{ stalled: number; requeued: number; settled: number }> {
	const stalled = await recoverStalledRuns(now);
	const requeued = await requeueLostRuns(now);
	const settled = await settleFinishedBatches(now);
	if (stalled || requeued || settled)
		console.log(
			`[geo-sampling] sweep recovered ${stalled} stalled, re-queued ${requeued} runs and settled ${settled} batches`,
		);
	return { stalled, requeued, settled };
}
