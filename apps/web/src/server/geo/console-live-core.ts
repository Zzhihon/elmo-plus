import {
	breakerGate,
	type CaptureFailureKind,
	type CaptureResult,
	checkQuota,
	classifyThrown,
	createCaptureAdapter,
	estimatedCostPerRun,
	type FetchLike,
	isSamplingPlatformEnabled,
	msUntilWindowOpens,
	parseAvailableWindow,
	resolveRetryPolicy,
	safeErrorDetail,
	validateTargetConfig,
} from "@workspace/geo-cn-providers";
import { assertGeoPermission, GeoError, type GeoPrincipal } from "@workspace/geo-domain";
import { findMentionRanges } from "@workspace/geo-reports/evaluation";
import { guardedFetch } from "@workspace/geo-site-ingestion";
import { db } from "@workspace/lib/db/db";
import type { DbConnection } from "@workspace/lib/db/db-connection";
import { geoSamplingAttempts, geoSamplingTargets, geoSimulationRuns } from "@workspace/lib/db/schema";
import { and, asc, desc, eq, gt, gte, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import {
	answerSegments,
	type ConsoleAnswer,
	consoleCitations,
	loadCurrentDictionary,
	ownBrandNameOf,
	ruleOutcome,
} from "./console-core";
import { readTargetCredential } from "./sampling-credentials";
import type { SamplingTargetRow } from "./sampling-targets-core";

export const LIVE_DAILY_LIMIT_PER_ORG = 30;
export const LIVE_DAILY_LIMIT_PER_USER = 10;
const MAX_TARGETS_PER_QUESTION = 4;
/** A row left RUNNING longer than this belongs to a request that died; it still counts toward the day's cap. */
const STALE_RUN_MS = 10 * 60_000;
const RUNNABLE_VERIFICATION = new Set(["PASSED", "LIMITED"]);

export const liveQuestionInputSchema = z.object({
	question: z.string().trim().min(4, "问题太短了，请写完整一些").max(500, "问题请控制在 500 字以内"),
	targetIds: z
		.array(z.guid())
		.min(1, "请至少选择一个平台")
		.max(MAX_TARGETS_PER_QUESTION, `一次最多问 ${MAX_TARGETS_PER_QUESTION} 个平台`),
});
export type LiveQuestionInput = z.infer<typeof liveQuestionInputSchema>;

export interface LiveQuota {
	orgLimit: number;
	orgUsed: number;
	userLimit: number;
	userUsed: number;
	remaining: number;
}

export interface LiveTargetOption {
	id: string;
	platform: SamplingTargetRow["platform"];
	surfaceMode: SamplingTargetRow["surfaceMode"];
	modelId: string | null;
	unavailableReason: string | null;
}

export interface LiveRunView {
	id: string;
	targetId: string | null;
	platform: SamplingTargetRow["platform"];
	surfaceMode: SamplingTargetRow["surfaceMode"];
	question: string;
	status: "RUNNING" | "SUCCEEDED" | "FAILED";
	errorMessage: string | null;
	latencyMs: number | null;
	createdAt: string;
	answer: ConsoleAnswer | null;
}

/** Days are counted in China time, the day the people using the console live in. */
function startOfChinaDay(now: Date): Date {
	const shifted = new Date(now.getTime() + 8 * 3_600_000);
	shifted.setUTCHours(0, 0, 0, 0);
	return new Date(shifted.getTime() - 8 * 3_600_000);
}

async function quotaUsage(conn: DbConnection, principal: GeoPrincipal, now: Date): Promise<LiveQuota> {
	const s = geoSimulationRuns;
	const [usage] = await conn
		.select({
			org: sql<number>`count(*)::int`,
			user: sql<number>`(count(*) filter (where ${s.userId} = ${principal.actorId}))::int`,
		})
		.from(s)
		.where(and(eq(s.organizationId, principal.organizationId), gte(s.createdAt, startOfChinaDay(now))));
	const orgUsed = usage?.org ?? 0;
	const userUsed = usage?.user ?? 0;
	return {
		orgLimit: LIVE_DAILY_LIMIT_PER_ORG,
		orgUsed,
		userLimit: LIVE_DAILY_LIMIT_PER_USER,
		userUsed,
		remaining: Math.max(0, Math.min(LIVE_DAILY_LIMIT_PER_ORG - orgUsed, LIVE_DAILY_LIMIT_PER_USER - userUsed)),
	};
}

function isConnected(target: SamplingTargetRow): boolean {
	return (
		target.enabled &&
		isSamplingPlatformEnabled(target.platform) &&
		RUNNABLE_VERIFICATION.has(target.verificationStatus) &&
		validateTargetConfig(target.surfaceMode, target.config, target.modelId).ok
	);
}

/** The worker's own gates, in words a customer can act on. Null when the target can be asked now. */
function unavailableReason(target: SamplingTargetRow, now: Date): string | null {
	if (target.surfaceMode === "MANUAL_EVIDENCE") return "这个渠道只能人工导入记录，不能实时提问";
	if (!target.enabled) return "这个平台的连接已停用";
	if (!isSamplingPlatformEnabled(target.platform)) return "当前部署没有开放这个平台";
	if (!RUNNABLE_VERIFICATION.has(target.verificationStatus)) return "这个平台的连接还没有通过验证";
	if (!validateTargetConfig(target.surfaceMode, target.config, target.modelId).ok) {
		return "这个平台的连接还没配置完整，请联系管理员";
	}
	const window = parseAvailableWindow(target.availableWindow);
	if (window.ok && msUntilWindowOpens(window.value, now) > 0) return "现在不在这个平台允许提问的时段内";
	const gate = breakerGate(
		{ state: target.breakerState, failureCount: target.breakerFailureCount, openedAt: target.breakerOpenedAt },
		resolveRetryPolicy(target.retryPolicy),
		now,
	);
	// A half-open breaker is the scheduled sampler's single probe; a live question must not take it.
	if (!gate.allow || gate.probe) return "这个平台最近连续出错，暂停提问，稍后会自动恢复";
	return null;
}

async function loadTargets(organizationId: string, ids?: readonly string[]): Promise<SamplingTargetRow[]> {
	const t = geoSamplingTargets;
	return db
		.select()
		.from(t)
		.where(and(eq(t.organizationId, organizationId), ids ? inArray(t.id, [...ids]) : undefined))
		.orderBy(asc(t.platform), asc(t.surfaceMode), asc(t.createdAt));
}

export async function getLiveSetup(
	principal: GeoPrincipal,
	now = new Date(),
): Promise<{ targets: LiveTargetOption[]; notConnected: number; quota: LiveQuota }> {
	assertGeoPermission(principal, "console.read");
	const [targets, quota] = await Promise.all([loadTargets(principal.organizationId), quotaUsage(db, principal, now)]);
	return {
		quota,
		// Platforms nobody has connected are not choices a customer can act on, so they are only counted.
		notConnected: targets.filter((target) => target.surfaceMode !== "MANUAL_EVIDENCE" && !isConnected(target)).length,
		targets: targets
			.filter((target) => target.surfaceMode !== "MANUAL_EVIDENCE" && isConnected(target))
			.map((target) => ({
				id: target.id,
				platform: target.platform,
				surfaceMode: target.surfaceMode,
				modelId: target.modelId,
				unavailableReason: unavailableReason(target, now),
			})),
	};
}

/**
 * A live question shares each target's per-minute, per-day, concurrency and cost limits
 * with scheduled sampling, so a demo can never starve or overrun the measured series.
 */
async function targetQuotaProblem(tx: DbConnection, target: SamplingTargetRow, now: Date): Promise<string | null> {
	const at = (ms: number) => new Date(now.getTime() - ms);
	const a = geoSamplingAttempts;
	const s = geoSimulationRuns;
	const [[attempts], [simulations]] = await Promise.all([
		tx
			.select({
				running: sql<number>`(count(*) filter (where ${a.status} = 'RUNNING' and ${a.startedAt} > ${at(STALE_RUN_MS)}))::int`,
				lastMinute: sql<number>`(count(*) filter (where ${a.startedAt} > ${at(60_000)}))::int`,
				lastDay: sql<number>`(count(*) filter (where ${a.startedAt} > ${at(86_400_000)}))::int`,
				cost: sql<string>`coalesce(sum(${a.costEstimate}), 0)`,
			})
			.from(a)
			.where(and(eq(a.targetId, target.id), gt(a.startedAt, at(30 * 86_400_000)))),
		tx
			.select({
				running: sql<number>`(count(*) filter (where ${s.status} = 'RUNNING' and ${s.createdAt} > ${at(STALE_RUN_MS)}))::int`,
				lastMinute: sql<number>`(count(*) filter (where ${s.createdAt} > ${at(60_000)}))::int`,
				lastDay: sql<number>`(count(*) filter (where ${s.createdAt} > ${at(86_400_000)}))::int`,
				total: sql<number>`count(*)::int`,
			})
			.from(s)
			.where(and(eq(s.targetId, target.id), gt(s.createdAt, at(30 * 86_400_000)))),
	]);
	const nextCostEstimate = estimatedCostPerRun(target.surfaceMode, target.config);
	const running = attempts.running + simulations.running;
	const quota = checkQuota(
		{
			maxConcurrency: target.maxConcurrency,
			perMinuteQuota: target.perMinuteQuota,
			perDayQuota: target.perDayQuota,
			costBudget: target.costBudget === null ? null : Number(target.costBudget),
			nextCostEstimate,
		},
		{
			running,
			lastMinute: attempts.lastMinute + simulations.lastMinute,
			lastDay: attempts.lastDay + simulations.lastDay,
			costLast30Days: Number(attempts.cost) + (attempts.running + simulations.total) * nextCostEstimate,
		},
	);
	if (quota.ok) return null;
	if (quota.reason === "COST_BUDGET") return "这个平台本月的调用预算已用完";
	if (quota.reason === "PER_DAY") return "这个平台今天的调用次数已用完";
	return "这个平台正忙，请过一分钟再试";
}

const FAILURE_WORDS: Record<CaptureFailureKind, string> = {
	TIMEOUT: "平台太久没有回答，请稍后再试",
	CAPTCHA: "平台要求人机验证，暂时无法自动提问",
	RATE_LIMITED: "平台提问太频繁被限流了，请稍后再试",
	NETWORK: "连不上这个平台，请稍后再试",
	FORBIDDEN: "平台拒绝了这次请求，可能是账号额度或权限不足",
	UNSUPPORTED: "这个平台暂时不支持这种提问",
	REFUSED: "平台以内容安全为由没有回答这个问题",
	UPSTREAM: "平台返回了错误，请稍后再试",
	INVALID_RESPONSE: "平台的回答无法识别",
	EMPTY_RESPONSE: "平台没有给出回答",
	CONFIG: "这个平台的连接还没配置好，请联系管理员",
	MANUAL_ONLY: "这个渠道只能人工导入记录，不能实时提问",
};

async function capture(
	target: SamplingTargetRow,
	runId: string,
	question: string,
	fetchImpl: FetchLike,
): Promise<CaptureResult> {
	const credential = await readTargetCredential(target.organizationId, target.credentialRef);
	const adapter = createCaptureAdapter(target, {
		credential,
		timeoutMs: resolveRetryPolicy(target.retryPolicy).timeoutMs,
		fetch: fetchImpl,
	});
	try {
		return await adapter.capture({
			promptId: runId,
			promptText: question,
			targetId: target.id,
			mode: target.surfaceMode,
			region: target.region ?? undefined,
			language: target.language,
			runId,
			idempotencyKey: `simulation:${runId}`,
		});
	} catch (error) {
		console.error(
			`[geo-console] live question failed for target ${target.id}: ${safeErrorDetail(error, { secrets: [credential], sensitiveTexts: [question] })}`,
		);
		const failure = classifyThrown(error);
		return {
			status: "FAILED",
			sampledAt: new Date().toISOString(),
			surfaceMode: target.surfaceMode,
			providerVersion: "unknown",
			failure,
			errorCode: failure.code,
		};
	}
}

type SimulationRow = typeof geoSimulationRuns.$inferSelect;

function toView(row: SimulationRow, dictionary: Awaited<ReturnType<typeof loadCurrentDictionary>>): LiveRunView {
	const answer =
		row.status === "SUCCEEDED" && row.answerText
			? (() => {
					const citations = row.citations.map((citation, index) => ({ ordinal: index + 1, ...citation }));
					return {
						source: "live" as const,
						id: row.id,
						promptId: null,
						questionText: row.question,
						buyerRoleTitle: null,
						platform: row.platform,
						surfaceMode: row.surfaceMode,
						sampledAt: (row.finishedAt ?? row.createdAt).toISOString(),
						modelVersion: row.modelVersion,
						answerText: row.answerText,
						segments: answerSegments(row.answerText, row.mentions),
						outcome: ruleOutcome(row.answerText, dictionary, citations),
						citations: consoleCitations(citations, dictionary),
						ownBrandName: ownBrandNameOf(dictionary),
					};
				})()
			: null;
	return {
		id: row.id,
		targetId: row.targetId,
		platform: row.platform,
		surfaceMode: row.surfaceMode,
		question: row.question,
		status: row.status,
		errorMessage: row.errorMessage,
		latencyMs: row.latencyMs,
		createdAt: row.createdAt.toISOString(),
		answer,
	};
}

/**
 * Asks the chosen platforms right now, through the same adapters and credentials as
 * scheduled sampling. The answers are kept only as simulation runs: they never become
 * observations, so they cannot move an exposure rate.
 */
export async function askLiveQuestion(
	principal: GeoPrincipal,
	input: LiveQuestionInput,
	deps: { fetch?: FetchLike; now?: () => Date } = {},
): Promise<{ runs: LiveRunView[]; quota: LiveQuota }> {
	assertGeoPermission(principal, "console.simulate");
	const clock = deps.now ?? (() => new Date());
	const targetIds = [...new Set(input.targetIds)];
	const targets = await loadTargets(principal.organizationId, targetIds);
	if (targets.length !== targetIds.length) throw new GeoError("NOT_FOUND", "选择的平台不存在");
	for (const target of targets) {
		const reason = unavailableReason(target, clock());
		if (reason) throw new GeoError("TARGET_UNAVAILABLE", reason);
	}

	const started = await db.transaction(async (tx) => {
		await tx.execute(
			sql`select pg_advisory_xact_lock(hashtext('geo-simulation'), hashtext(${principal.organizationId}))`,
		);
		const now = clock();
		const quota = await quotaUsage(tx, principal, now);
		if (quota.orgUsed + targets.length > quota.orgLimit) {
			throw new GeoError("RATE_LIMITED", `今天团队的实时提问次数不够了（还剩 ${quota.orgLimit - quota.orgUsed} 次）`);
		}
		if (quota.userUsed + targets.length > quota.userLimit) {
			throw new GeoError("RATE_LIMITED", `你今天的实时提问次数不够了（还剩 ${quota.userLimit - quota.userUsed} 次）`);
		}
		for (const target of targets) {
			await tx.execute(sql`select pg_advisory_xact_lock(hashtext('geo-sampling-target'), hashtext(${target.id}))`);
			const problem = await targetQuotaProblem(tx, target, now);
			if (problem) throw new GeoError("RATE_LIMITED", problem);
		}
		return tx
			.insert(geoSimulationRuns)
			.values(
				targets.map((target) => ({
					organizationId: principal.organizationId,
					userId: principal.actorId,
					question: input.question,
					platform: target.platform,
					surfaceMode: target.surfaceMode,
					targetId: target.id,
					status: "RUNNING" as const,
				})),
			)
			.returning();
	});

	const dictionary = await loadCurrentDictionary(principal.organizationId);
	const fetchImpl = deps.fetch ?? guardedFetch;
	const finished = await Promise.all(
		started.map(async (row) => {
			const target = targets.find((candidate) => candidate.id === row.targetId) as SamplingTargetRow;
			const startedAt = Date.now();
			const result = await capture(target, row.id, input.question, fetchImpl);
			const latencyMs = Date.now() - startedAt;
			const answer = result.failure ? null : (result.responseText ?? null);
			const failure = result.failure ?? (answer ? null : { kind: "EMPTY_RESPONSE" as const, code: "EMPTY_RESPONSE" });
			const [updated] = await db
				.update(geoSimulationRuns)
				.set(
					failure
						? {
								status: "FAILED",
								errorCode: failure.code,
								errorMessage: FAILURE_WORDS[failure.kind],
								latencyMs,
								finishedAt: new Date(),
							}
						: {
								status: "SUCCEEDED",
								answerText: answer,
								citations: (result.citations ?? []).map(({ url, title }) => (title ? { url, title } : { url })),
								mentions: findMentionRanges(answer ?? "", dictionary),
								modelVersion: result.modelVersion ?? null,
								latencyMs,
								finishedAt: new Date(),
							},
				)
				.where(eq(geoSimulationRuns.id, row.id))
				.returning();
			return toView(updated ?? row, dictionary);
		}),
	);
	return { runs: finished, quota: await quotaUsage(db, principal, clock()) };
}

/** The asker's own recent live questions, so a result is not lost when the page reloads. */
export async function listRecentLiveRuns(principal: GeoPrincipal, limit = 12): Promise<LiveRunView[]> {
	assertGeoPermission(principal, "console.read");
	const s = geoSimulationRuns;
	const [rows, dictionary] = await Promise.all([
		db
			.select()
			.from(s)
			.where(and(eq(s.organizationId, principal.organizationId), eq(s.userId, principal.actorId)))
			.orderBy(desc(s.createdAt))
			.limit(limit),
		loadCurrentDictionary(principal.organizationId),
	]);
	return rows.map((row) => toView(row, dictionary));
}
