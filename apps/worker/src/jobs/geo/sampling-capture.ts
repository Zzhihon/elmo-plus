import {
	type BreakerSnapshot,
	breakerAfter,
	breakerGate,
	type CaptureFailure,
	type CaptureResult,
	captureFailure,
	checkQuota,
	classifyThrown,
	createCaptureAdapter,
	decideRetry,
	estimatedCostPerRun,
	type FetchLike,
	failureRunStatus,
	isSamplingPlatformEnabled,
	msUntilWindowOpens,
	parseAvailableWindow,
	type RetryPolicy,
	resolveRetryPolicy,
	safeErrorDetail,
	sourceMethodVersion,
} from "@workspace/geo-cn-providers";
import { isTerminalRunStatus } from "@workspace/geo-domain";
import { geoObjectKey, getObjectStore } from "@workspace/geo-evidence";
import { guardedFetch } from "@workspace/geo-site-ingestion";
import { db } from "@workspace/lib/db/db";
import { geoSamplingAttempts, geoSamplingRuns, geoSamplingTargets } from "@workspace/lib/db/schema";
import { raiseGeoAlert, resolveGeoAlert } from "@workspace/lib/geo/alerts";
import { and, eq, gt, sql } from "drizzle-orm";
import { loadTargetCredential } from "./sampling-credentials";
import { finalizeRun, loadRunContext, type RunContext, scheduleRun } from "./sampling-store";

export interface CaptureJobData {
	organizationId: string;
	runId: string;
}

/** Longer than the longest allowed request timeout, so a live attempt is never taken for a stalled one. */
export const STALE_ATTEMPT_MS = 10 * 60_000;
const RUNNABLE_VERIFICATION = new Set(["PASSED", "LIMITED"]);

export type CaptureJobOutcome =
	| { kind: "skipped"; reason: string }
	| { kind: "deferred"; reason: string; delayMs: number }
	| { kind: "retrying"; delayMs: number }
	| { kind: "finished"; status: string };

/** Stops a run for good before anything is sent: a disabled or unverified target produces no sample at all. */
function gateFailure(ctx: RunContext): CaptureFailure | null {
	const { target } = ctx;
	if (target.surfaceMode === "MANUAL_EVIDENCE") {
		return captureFailure("MANUAL_ONLY", "MANUAL_ONLY", "人工证据目标只能通过导入采样");
	}
	if (!target.enabled) return captureFailure("CONFIG", "TARGET_DISABLED", "采样目标已停用");
	if (!isSamplingPlatformEnabled(target.platform)) {
		return captureFailure("CONFIG", "PLATFORM_DISABLED", "该平台的自动采样在部署中未开启");
	}
	if (!RUNNABLE_VERIFICATION.has(target.verificationStatus)) {
		return captureFailure("CONFIG", "TARGET_UNVERIFIED", "采样目标未通过数据源验证");
	}
	return null;
}

function breakerSnapshot(ctx: RunContext): BreakerSnapshot {
	return {
		state: ctx.target.breakerState,
		failureCount: ctx.target.breakerFailureCount,
		openedAt: ctx.target.breakerOpenedAt,
	};
}

type SlotResult =
	| { kind: "acquired"; attemptId: string; attemptNo: number }
	| { kind: "busy"; reason: string; delayMs: number }
	| { kind: "budget" }
	| { kind: "gone" };

/**
 * Takes a per-target lock, then checks concurrency, rate and budget against the attempts
 * already recorded and claims the run in the same transaction, so two workers can never
 * both decide there is room for one more.
 */
async function acquireSlot(ctx: RunContext, probe: boolean, now: Date): Promise<SlotResult> {
	const { run, target } = ctx;
	return db.transaction(async (tx) => {
		await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('geo-sampling-target'), hashtext(${target.id}))`);
		const [locked] = await tx.select().from(geoSamplingRuns).where(eq(geoSamplingRuns.id, run.id)).for("update");
		if (!locked || locked.status !== "PLANNED") return { kind: "gone" };

		const at = (ms: number) => new Date(now.getTime() - ms);
		const a = geoSamplingAttempts;
		const [usage] = await tx
			.select({
				running: sql<number>`(count(*) filter (where ${a.status} = 'RUNNING' and ${a.startedAt} > ${at(STALE_ATTEMPT_MS)}))::int`,
				lastMinute: sql<number>`(count(*) filter (where ${a.startedAt} > ${at(60_000)}))::int`,
				lastDay: sql<number>`(count(*) filter (where ${a.startedAt} > ${at(86_400_000)}))::int`,
				cost: sql<string>`coalesce(sum(${a.costEstimate}), 0)`,
			})
			.from(a)
			.where(and(eq(a.targetId, target.id), gt(a.startedAt, at(30 * 86_400_000))));

		const quota = checkQuota(
			{
				maxConcurrency: probe ? 1 : target.maxConcurrency,
				perMinuteQuota: target.perMinuteQuota,
				perDayQuota: target.perDayQuota,
				costBudget: target.costBudget === null ? null : Number(target.costBudget),
				nextCostEstimate: estimatedCostPerRun(target.surfaceMode, target.config),
			},
			{
				running: usage.running,
				lastMinute: usage.lastMinute,
				lastDay: usage.lastDay,
				costLast30Days: Number(usage.cost),
			},
		);
		if (!quota.ok)
			return quota.reason === "COST_BUDGET"
				? { kind: "budget" }
				: { kind: "busy", reason: quota.reason, delayMs: quota.retryAfterMs };

		if (probe && target.breakerState === "OPEN") {
			await tx
				.update(geoSamplingTargets)
				.set({ breakerState: "HALF_OPEN" })
				.where(eq(geoSamplingTargets.id, target.id));
		}
		const attemptNo = locked.attemptCount + 1;
		const [attempt] = await tx
			.insert(geoSamplingAttempts)
			.values({
				organizationId: run.organizationId,
				runId: run.id,
				targetId: target.id,
				attemptNo,
				startedAt: now,
				status: "RUNNING",
			})
			.returning({ id: geoSamplingAttempts.id });
		await tx
			.update(geoSamplingRuns)
			.set({ status: "RUNNING", attemptCount: attemptNo, nextAttemptAt: null })
			.where(eq(geoSamplingRuns.id, run.id));
		return { kind: "acquired", attemptId: attempt.id, attemptNo };
	});
}

async function updateBreaker(ctx: RunContext, outcome: CaptureResult, policy: RetryPolicy, now: Date): Promise<void> {
	const { target } = ctx;
	await db.transaction(async (tx) => {
		const [current] = await tx
			.select({
				state: geoSamplingTargets.breakerState,
				failureCount: geoSamplingTargets.breakerFailureCount,
				openedAt: geoSamplingTargets.breakerOpenedAt,
			})
			.from(geoSamplingTargets)
			.where(eq(geoSamplingTargets.id, target.id))
			.for("update");
		const next = breakerAfter(
			current,
			outcome.failure ? { kind: "failure", failure: outcome.failure } : { kind: "success" },
			policy,
			now,
		);
		if (next.state === current.state && next.failureCount === current.failureCount) return;
		await tx
			.update(geoSamplingTargets)
			.set({ breakerState: next.state, breakerFailureCount: next.failureCount, breakerOpenedAt: next.openedAt })
			.where(eq(geoSamplingTargets.id, target.id));
		const dedupeKey = `sampling-breaker:${target.id}`;
		if (next.state === "OPEN" && current.state !== "OPEN") {
			await raiseGeoAlert(tx, {
				organizationId: target.organizationId,
				kind: "sampling_breaker_open",
				severity: "WARNING",
				dedupeKey,
				context: {
					targetId: target.id,
					platform: target.platform,
					surfaceMode: target.surfaceMode,
					failures: next.failureCount,
				},
			});
		} else if (next.state === "CLOSED" && current.state !== "CLOSED") {
			await resolveGeoAlert(tx, { organizationId: target.organizationId, dedupeKey });
		}
	});
}

/** The provider's body goes to the object store before the observation exists, so an observation never points at nothing. */
async function storeRawEvidence(ctx: RunContext, attemptNo: number, result: CaptureResult): Promise<string> {
	const key = geoObjectKey(ctx.run.organizationId, "observations", ctx.run.id, `attempt-${attemptNo}.json`);
	await getObjectStore().put(
		key,
		JSON.stringify({
			runId: ctx.run.id,
			targetId: ctx.target.id,
			surfaceMode: result.surfaceMode,
			providerVersion: result.providerVersion,
			sampledAt: result.sampledAt,
			providerTraceId: result.providerTraceId ?? null,
			response: result.raw ?? null,
		}),
		{ contentType: "application/json" },
	);
	return key;
}

async function runCapture(ctx: RunContext, policy: RetryPolicy, fetchImpl?: FetchLike): Promise<CaptureResult> {
	const credential = await loadTargetCredential(ctx.target.credentialRef);
	const adapter = createCaptureAdapter(ctx.target, {
		credential,
		timeoutMs: policy.timeoutMs,
		fetch: fetchImpl ?? guardedFetch,
	});
	try {
		return await adapter.capture({
			promptId: ctx.run.promptId,
			promptText: ctx.questionText,
			targetId: ctx.target.id,
			mode: ctx.target.surfaceMode,
			region: ctx.target.region ?? undefined,
			language: ctx.target.language,
			runId: ctx.run.id,
			idempotencyKey: ctx.run.idempotencyKey,
		});
	} catch (error) {
		console.error(
			`[geo-sampling] adapter threw for run ${ctx.run.id}: ${safeErrorDetail(error, { secrets: [credential], sensitiveTexts: [ctx.questionText] })}`,
		);
		const failure = classifyThrown(error);
		return {
			status: "FAILED",
			sampledAt: new Date().toISOString(),
			surfaceMode: ctx.target.surfaceMode,
			providerVersion: "unknown",
			failure,
			errorCode: failure.code,
		};
	}
}

async function recordAttempt(attemptId: string, startedAt: number, result: CaptureResult): Promise<void> {
	await db
		.update(geoSamplingAttempts)
		.set({
			durationMs: Date.now() - startedAt,
			status: result.failure ? failureRunStatus(result.failure) : result.status === "PARTIAL" ? "PARTIAL" : "VALID",
			errorCode: result.failure?.code ?? result.errorCode ?? null,
			costEstimate: result.costEstimate === undefined ? null : result.costEstimate.toFixed(4),
			providerTraceId: result.providerTraceId ?? null,
		})
		.where(eq(geoSamplingAttempts.id, attemptId));
}

async function settleFailure(
	ctx: RunContext,
	failure: CaptureFailure,
	attemptNo: number,
	policy: RetryPolicy,
	capture?: CaptureResult,
): Promise<CaptureJobOutcome> {
	const decision = decideRetry(failure, attemptNo, policy);
	if (decision.retry) {
		await scheduleRun(ctx.run.organizationId, ctx.run.id, decision.delayMs, {
			errorCode: failure.code,
			errorDetail: failure.message,
		});
		return { kind: "retrying", delayMs: decision.delayMs };
	}
	await finalizeRun(ctx, {
		status: decision.status,
		errorCode: failure.code,
		errorDetail: failure.message,
		capture,
		sourceMethodVersion: capture ? sourceMethodVersion(ctx.target, capture.providerVersion) : null,
	});
	return { kind: "finished", status: decision.status };
}

async function deferOrStop(ctx: RunContext, now: Date): Promise<CaptureJobOutcome | null> {
	const gate = gateFailure(ctx);
	if (gate) {
		const status = failureRunStatus(gate);
		await finalizeRun(ctx, { status, errorCode: gate.code, errorDetail: gate.message });
		return { kind: "finished", status };
	}
	const window = parseAvailableWindow(ctx.target.availableWindow);
	const waitForWindow = window.ok ? msUntilWindowOpens(window.value, now) : 0;
	if (waitForWindow > 0) {
		await scheduleRun(ctx.run.organizationId, ctx.run.id, waitForWindow, { errorCode: "OUTSIDE_WINDOW" });
		return { kind: "deferred", reason: "OUTSIDE_WINDOW", delayMs: waitForWindow };
	}
	return null;
}

async function settleBudget(ctx: RunContext): Promise<CaptureJobOutcome> {
	await db.transaction((tx) =>
		raiseGeoAlert(tx, {
			organizationId: ctx.target.organizationId,
			kind: "sampling_budget_exhausted",
			severity: "WARNING",
			dedupeKey: `sampling-budget:${ctx.target.id}`,
			context: { targetId: ctx.target.id, platform: ctx.target.platform },
		}),
	);
	await finalizeRun(ctx, {
		status: "RATE_LIMITED",
		errorCode: "COST_BUDGET_EXCEEDED",
		errorDetail: "采样目标近 30 天成本预算已用完",
	});
	return { kind: "finished", status: "RATE_LIMITED" };
}

type Preflight =
	| { proceed: true; probe: boolean; policy: RetryPolicy }
	| { proceed: false; outcome: CaptureJobOutcome };

async function preflight(ctx: RunContext, now: Date): Promise<Preflight> {
	const { run, batch } = ctx;
	if (isTerminalRunStatus(run.status) || run.status === "RUNNING") {
		return { proceed: false, outcome: { kind: "skipped", reason: run.status } };
	}
	if (batch.status === "PAUSED" || batch.status === "CANCELLED") {
		return { proceed: false, outcome: { kind: "skipped", reason: batch.status } };
	}
	if (run.nextAttemptAt && run.nextAttemptAt.getTime() > now.getTime() + 1000) {
		return { proceed: false, outcome: { kind: "skipped", reason: "NOT_DUE" } };
	}
	const stopped = await deferOrStop(ctx, now);
	if (stopped) return { proceed: false, outcome: stopped };
	const policy = resolveRetryPolicy(ctx.target.retryPolicy);
	const gate = breakerGate(breakerSnapshot(ctx), policy, now);
	if (!gate.allow) {
		await scheduleRun(run.organizationId, run.id, gate.retryAfterMs, { errorCode: "BREAKER_OPEN" });
		return { proceed: false, outcome: { kind: "deferred", reason: "BREAKER_OPEN", delayMs: gate.retryAfterMs } };
	}
	return { proceed: true, probe: gate.probe, policy };
}

async function attempt(
	ctx: RunContext,
	slot: { attemptId: string; attemptNo: number },
	policy: RetryPolicy,
	options: { clock: () => Date; fetch?: FetchLike },
): Promise<CaptureJobOutcome> {
	const startedAt = Date.now();
	let result = await runCapture(ctx, policy, options.fetch);
	await updateBreaker(ctx, result, policy, options.clock());
	let evidenceUri: string | null = null;
	if (!result.failure) {
		try {
			evidenceUri = await storeRawEvidence(ctx, slot.attemptNo, result);
		} catch (error) {
			console.error(`[geo-sampling] raw evidence not stored for run ${ctx.run.id}: ${safeErrorDetail(error)}`);
			const failure = captureFailure("UPSTREAM", "EVIDENCE_STORE_UNAVAILABLE", "原始证据写入对象存储失败");
			result = { ...result, status: "FAILED", failure, errorCode: failure.code };
		}
	}
	await recordAttempt(slot.attemptId, startedAt, result);

	if (result.failure) return settleFailure(ctx, result.failure, slot.attemptNo, policy, result);
	const status = result.status === "PARTIAL" ? "PARTIAL" : "VALID";
	await finalizeRun(ctx, {
		status,
		errorCode: result.errorCode ?? null,
		capture: result,
		evidenceUri,
		sourceMethodVersion: sourceMethodVersion(ctx.target, result.providerVersion),
	});
	return { kind: "finished", status };
}

/**
 * One attempt at one run. Every exit leaves the run either terminal with its observation
 * written, or PLANNED with a due time and a job queued for it; the sweep covers a job lost
 * in between.
 */
export async function processCaptureJob(
	data: CaptureJobData,
	options: { now?: () => Date; fetch?: FetchLike } = {},
): Promise<CaptureJobOutcome> {
	const clock = options.now ?? (() => new Date());
	const ctx = await loadRunContext(data.organizationId, data.runId);
	if (!ctx) return { kind: "skipped", reason: "NOT_FOUND" };
	const now = clock();
	const ready = await preflight(ctx, now);
	if (!ready.proceed) return ready.outcome;

	const slot = await acquireSlot(ctx, ready.probe, now);
	if (slot.kind === "gone") return { kind: "skipped", reason: "CLAIMED" };
	if (slot.kind === "budget") return settleBudget(ctx);
	if (slot.kind === "busy") {
		await scheduleRun(ctx.run.organizationId, ctx.run.id, slot.delayMs);
		return { kind: "deferred", reason: slot.reason, delayMs: slot.delayMs };
	}
	return attempt(ctx, slot, ready.policy, { clock, fetch: options.fetch });
}
