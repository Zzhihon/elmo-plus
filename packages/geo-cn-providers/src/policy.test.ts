import { describe, expect, it } from "vitest";
import { captureFailure } from "./classify";
import {
	type BreakerSnapshot,
	backoffDelayMs,
	breakerAfter,
	breakerGate,
	checkQuota,
	isWithinWindow,
	msUntilWindowOpens,
	resolveRetryPolicy,
} from "./policy";

const policy = resolveRetryPolicy({
	baseDelayMs: 1000,
	maxDelayMs: 8000,
	breakerThreshold: 3,
	breakerCooldownMs: 60_000,
});
const limits = { maxConcurrency: 2, perMinuteQuota: 5, perDayQuota: 100, costBudget: 10, nextCostEstimate: 1 };
const idle = { running: 0, lastMinute: 0, lastDay: 0, costLast30Days: 0 };

describe("quota", () => {
	it("lets a run through while every limit has room", () => {
		expect(checkQuota(limits, idle)).toEqual({ ok: true });
	});

	it("defers on concurrency, per-minute and per-day limits", () => {
		expect(checkQuota(limits, { ...idle, running: 2 })).toMatchObject({ ok: false, reason: "CONCURRENCY" });
		expect(checkQuota(limits, { ...idle, lastMinute: 5 })).toMatchObject({
			ok: false,
			reason: "PER_MINUTE",
			retryAfterMs: 60_000,
		});
		expect(checkQuota(limits, { ...idle, lastDay: 100 })).toMatchObject({ ok: false, reason: "PER_DAY" });
	});

	it("stops outright once the next run would exceed the cost budget", () => {
		expect(checkQuota(limits, { ...idle, costLast30Days: 9.5 })).toEqual({
			ok: false,
			reason: "COST_BUDGET",
			retryAfterMs: null,
		});
		expect(checkQuota({ ...limits, costBudget: null }, { ...idle, costLast30Days: 1e6 })).toEqual({ ok: true });
	});
});

describe("backoff", () => {
	it("doubles per attempt up to the cap and respects Retry-After", () => {
		const noJitter = () => 0;
		expect(backoffDelayMs(1, policy, undefined, noJitter)).toBe(1000);
		expect(backoffDelayMs(3, policy, undefined, noJitter)).toBe(4000);
		expect(backoffDelayMs(10, policy, undefined, noJitter)).toBe(8000);
		expect(backoffDelayMs(1, policy, { retryAfterMs: 30_000 }, noJitter)).toBe(30_000);
	});

	it("clamps nonsense policy values instead of disabling retries", () => {
		const resolved = resolveRetryPolicy({ maxAttempts: 0, timeoutMs: -1, baseDelayMs: "fast" });
		expect(resolved.maxAttempts).toBe(1);
		expect(resolved.timeoutMs).toBeGreaterThanOrEqual(5000);
		expect(resolved.baseDelayMs).toBe(30_000);
	});
});

describe("circuit breaker", () => {
	const closed: BreakerSnapshot = { state: "CLOSED", failureCount: 0, openedAt: null };
	const timeout = { kind: "failure" as const, failure: captureFailure("TIMEOUT", "TIMEOUT", "超时") };
	const t0 = new Date("2026-11-03T00:00:00Z");

	it("opens after consecutive platform failures and blocks until the cooldown ends", () => {
		let snapshot = closed;
		for (let i = 0; i < 3; i++) snapshot = breakerAfter(snapshot, timeout, policy, t0);
		expect(snapshot.state).toBe("OPEN");
		expect(breakerGate(snapshot, policy, new Date(t0.getTime() + 30_000))).toEqual({
			allow: false,
			retryAfterMs: 30_000,
		});
		expect(breakerGate(snapshot, policy, new Date(t0.getTime() + 61_000))).toEqual({ allow: true, probe: true });
	});

	it("closes on a successful probe and reopens on a failed one", () => {
		const halfOpen: BreakerSnapshot = { state: "HALF_OPEN", failureCount: 3, openedAt: t0 };
		expect(breakerAfter(halfOpen, { kind: "success" }, policy, t0)).toEqual(closed);
		expect(breakerAfter(halfOpen, timeout, policy, t0).state).toBe("OPEN");
	});

	it("ignores refusals of a single question, which say nothing about platform health", () => {
		const captcha = { kind: "failure" as const, failure: captureFailure("CAPTCHA", "CAPTCHA_REQUIRED", "验证码") };
		expect(breakerAfter(closed, captcha, policy, t0)).toEqual(closed);
	});
});

describe("available window", () => {
	const window = { timezone: "Asia/Shanghai", days: [1, 2, 3, 4, 5], start: "09:00", end: "18:00" };

	it("is open on a weekday during working hours in the target's time zone", () => {
		expect(isWithinWindow(window, new Date("2026-11-03T02:00:00Z"))).toBe(true);
		expect(isWithinWindow(window, new Date("2026-11-03T11:00:00Z"))).toBe(false);
		expect(isWithinWindow(window, new Date("2026-11-08T02:00:00Z"))).toBe(false);
	});

	it("reports how long until it next opens", () => {
		expect(msUntilWindowOpens(window, new Date("2026-11-03T00:00:00Z"))).toBe(60 * 60_000);
		expect(msUntilWindowOpens(null, new Date())).toBe(0);
	});
});
