import type { GeoBreakerState, GeoRunStatus } from "@workspace/geo-domain";
import { type CaptureFailure, failureRunStatus, failureTripsBreaker } from "./classify";

export interface RetryPolicy {
	maxAttempts: number;
	baseDelayMs: number;
	maxDelayMs: number;
	timeoutMs: number;
	breakerThreshold: number;
	breakerCooldownMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
	maxAttempts: 3,
	baseDelayMs: 30_000,
	maxDelayMs: 15 * 60_000,
	timeoutMs: 90_000,
	breakerThreshold: 5,
	breakerCooldownMs: 10 * 60_000,
};

const POLICY_BOUNDS: Record<keyof RetryPolicy, [number, number]> = {
	maxAttempts: [1, 10],
	baseDelayMs: [1_000, 60 * 60_000],
	maxDelayMs: [1_000, 6 * 60 * 60_000],
	timeoutMs: [5_000, 5 * 60_000],
	breakerThreshold: [1, 100],
	breakerCooldownMs: [10_000, 24 * 60 * 60_000],
};

/** Unknown or out-of-range fields fall back to defaults or are clamped, so a bad edit cannot stop retries for good. */
export function resolveRetryPolicy(raw: unknown): RetryPolicy {
	const input = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	const policy = { ...DEFAULT_RETRY_POLICY };
	for (const key of Object.keys(POLICY_BOUNDS) as (keyof RetryPolicy)[]) {
		const value = input[key];
		if (typeof value !== "number" || !Number.isFinite(value)) continue;
		const [min, max] = POLICY_BOUNDS[key];
		policy[key] = Math.min(max, Math.max(min, Math.round(value)));
	}
	policy.maxDelayMs = Math.max(policy.maxDelayMs, policy.baseDelayMs);
	return policy;
}

/** Exponential from the base, capped, with up to 20% jitter, and never sooner than the platform's Retry-After. */
export function backoffDelayMs(
	attemptNo: number,
	policy: RetryPolicy,
	failure?: Pick<CaptureFailure, "retryAfterMs">,
	random: () => number = Math.random,
): number {
	const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.max(0, attemptNo - 1));
	const jittered = Math.round(exponential * (1 + 0.2 * random()));
	return Math.max(Math.min(jittered, policy.maxDelayMs), failure?.retryAfterMs ?? 0);
}

export type RetryDecision = { retry: true; delayMs: number } | { retry: false; status: GeoRunStatus };

/**
 * Only transient failures are retried. A captcha, a refusal or a missing permission
 * goes straight to its final status: retrying would only hammer the platform.
 */
export function decideRetry(
	failure: CaptureFailure,
	attemptNo: number,
	policy: RetryPolicy,
	random: () => number = Math.random,
): RetryDecision {
	if (failure.retryable && attemptNo < policy.maxAttempts) {
		return { retry: true, delayMs: backoffDelayMs(attemptNo, policy, failure, random) };
	}
	return { retry: false, status: failureRunStatus(failure) };
}

export interface QuotaLimits {
	maxConcurrency: number;
	perMinuteQuota: number | null;
	perDayQuota: number | null;
	/** Over a rolling 30 days, in the same unit as the cost estimates. */
	costBudget: number | null;
	nextCostEstimate: number;
}

export interface QuotaUsage {
	running: number;
	lastMinute: number;
	lastDay: number;
	costLast30Days: number;
}

export type QuotaDecision =
	| { ok: true }
	| { ok: false; reason: "CONCURRENCY" | "PER_MINUTE" | "PER_DAY"; retryAfterMs: number }
	| { ok: false; reason: "COST_BUDGET"; retryAfterMs: null };

export function checkQuota(limits: QuotaLimits, usage: QuotaUsage): QuotaDecision {
	if (limits.costBudget !== null && usage.costLast30Days + limits.nextCostEstimate > limits.costBudget) {
		return { ok: false, reason: "COST_BUDGET", retryAfterMs: null };
	}
	if (limits.perDayQuota !== null && usage.lastDay >= limits.perDayQuota) {
		return { ok: false, reason: "PER_DAY", retryAfterMs: 60 * 60_000 };
	}
	if (limits.perMinuteQuota !== null && usage.lastMinute >= limits.perMinuteQuota) {
		return { ok: false, reason: "PER_MINUTE", retryAfterMs: 60_000 };
	}
	if (usage.running >= Math.max(1, limits.maxConcurrency)) {
		return { ok: false, reason: "CONCURRENCY", retryAfterMs: 15_000 };
	}
	return { ok: true };
}

export interface BreakerSnapshot {
	state: GeoBreakerState;
	failureCount: number;
	openedAt: Date | null;
}

export type BreakerGate = { allow: true; probe: boolean } | { allow: false; retryAfterMs: number };

/** Once the cooldown has passed an open breaker lets one probe through, and the caller holds it to one at a time. */
export function breakerGate(snapshot: BreakerSnapshot, policy: RetryPolicy, now: Date): BreakerGate {
	if (snapshot.state === "CLOSED") return { allow: true, probe: false };
	if (snapshot.state === "HALF_OPEN") return { allow: true, probe: true };
	const openedAt = snapshot.openedAt?.getTime() ?? 0;
	const remaining = openedAt + policy.breakerCooldownMs - now.getTime();
	return remaining > 0 ? { allow: false, retryAfterMs: remaining } : { allow: true, probe: true };
}

export type CaptureOutcome = { kind: "success" } | { kind: "failure"; failure: CaptureFailure };

export function breakerAfter(
	snapshot: BreakerSnapshot,
	outcome: CaptureOutcome,
	policy: RetryPolicy,
	now: Date,
): BreakerSnapshot {
	if (outcome.kind === "success") return { state: "CLOSED", failureCount: 0, openedAt: null };
	if (!failureTripsBreaker(outcome.failure)) return snapshot;
	const failureCount = snapshot.failureCount + 1;
	if (snapshot.state !== "CLOSED" || failureCount >= policy.breakerThreshold) {
		return { state: "OPEN", failureCount, openedAt: now };
	}
	return { state: "CLOSED", failureCount, openedAt: null };
}

export interface AvailableWindow {
	timezone: string;
	/** ISO weekdays, 1 = Monday … 7 = Sunday. */
	days: number[];
	start: string;
	end: string;
}

const TIME_SHAPE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function parseAvailableWindow(
	raw: unknown,
): { ok: true; value: AvailableWindow | null } | { ok: false; error: string } {
	if (raw === null || raw === undefined) return { ok: true, value: null };
	if (typeof raw !== "object") return { ok: false, error: "可用时间窗口必须是对象" };
	const input = raw as Record<string, unknown>;
	const timezone = typeof input.timezone === "string" && input.timezone ? input.timezone : "Asia/Shanghai";
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: timezone });
	} catch {
		return { ok: false, error: `未知时区：${timezone}` };
	}
	const days = Array.isArray(input.days) ? input.days : [1, 2, 3, 4, 5, 6, 7];
	if (
		!days.every((day) => Number.isInteger(day) && (day as number) >= 1 && (day as number) <= 7) ||
		days.length === 0
	) {
		return { ok: false, error: "days 必须是 1–7 的整数列表" };
	}
	const start = input.start;
	const end = input.end;
	if (typeof start !== "string" || !TIME_SHAPE.test(start) || typeof end !== "string" || !TIME_SHAPE.test(end)) {
		return { ok: false, error: "start 和 end 必须是 HH:MM" };
	}
	if (start === end) return { ok: false, error: "start 与 end 不能相同" };
	return { ok: true, value: { timezone, days: days as number[], start, end } };
}

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

function localClock(date: Date, timezone: string): { weekday: number; minutes: number } {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: timezone,
		weekday: "short",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	}).formatToParts(date);
	const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
	return { weekday: WEEKDAYS[get("weekday")] ?? 1, minutes: Number(get("hour")) * 60 + Number(get("minute")) };
}

function toMinutes(time: string): number {
	const [hours, minutes] = time.split(":").map(Number);
	return hours * 60 + minutes;
}

/** An overnight window (start after end) belongs to the day it starts on. */
export function isWithinWindow(window: AvailableWindow, now: Date): boolean {
	const { weekday, minutes } = localClock(now, window.timezone);
	const start = toMinutes(window.start);
	const end = toMinutes(window.end);
	if (start < end) return window.days.includes(weekday) && minutes >= start && minutes < end;
	if (minutes >= start) return window.days.includes(weekday);
	const previousDay = weekday === 1 ? 7 : weekday - 1;
	return minutes < end && window.days.includes(previousDay);
}

const WINDOW_STEP_MS = 5 * 60_000;
const WINDOW_HORIZON_MS = 8 * 24 * 60 * 60_000;

export function msUntilWindowOpens(window: AvailableWindow | null, now: Date): number {
	if (!window || isWithinWindow(window, now)) return 0;
	const aligned = Math.ceil(now.getTime() / WINDOW_STEP_MS) * WINDOW_STEP_MS;
	for (let at = aligned; at - now.getTime() <= WINDOW_HORIZON_MS; at += WINDOW_STEP_MS) {
		if (isWithinWindow(window, new Date(at))) return at - now.getTime();
	}
	return WINDOW_HORIZON_MS;
}
