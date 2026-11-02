import { describe, expect, it } from "vitest";
import { samplingRunIdempotencyKey } from "./queues";
import {
	countsAsValidSample,
	deriveBatchStatus,
	pickCountedSamples,
	samplingSlotKey,
	summarizeBatch,
} from "./sampling";

const slot = { batchId: "b1", promptId: "p1", targetId: "t1", repeatIndex: 0 };

describe("sampling idempotency keys", () => {
	it("gives the same planned sample the same key however often it is retried", () => {
		expect(samplingRunIdempotencyKey(slot)).toBe(samplingRunIdempotencyKey({ ...slot }));
		expect(samplingSlotKey(slot)).toBe(samplingRunIdempotencyKey(slot));
	});

	it("separates repeats, targets and prompts", () => {
		const keys = new Set([
			samplingRunIdempotencyKey(slot),
			samplingRunIdempotencyKey({ ...slot, repeatIndex: 1 }),
			samplingRunIdempotencyKey({ ...slot, targetId: "t2" }),
			samplingRunIdempotencyKey({ ...slot, promptId: "p2" }),
			samplingRunIdempotencyKey({ ...slot, batchId: "b2" }),
		]);
		expect(keys.size).toBe(5);
	});

	it("gives an explicit re-sample its own run key but keeps it on the original slot", () => {
		const resample = samplingRunIdempotencyKey({ ...slot, resampleOf: "run-1" });
		expect(resample).not.toBe(samplingRunIdempotencyKey(slot));
		expect(samplingSlotKey(slot)).toBe(samplingRunIdempotencyKey(slot));
	});
});

describe("denominator", () => {
	it("counts only complete answers", () => {
		expect(countsAsValidSample("VALID")).toBe(true);
		for (const status of [
			"PARTIAL",
			"FAILED",
			"TIMEOUT",
			"CAPTCHA",
			"RATE_LIMITED",
			"UNAVAILABLE",
			"NETWORK_ERROR",
		] as const) {
			expect(countsAsValidSample(status)).toBe(false);
		}
	});

	it("counts a slot once even when it was re-sampled", () => {
		const counted = pickCountedSamples([
			{ slotKey: "s1", status: "TIMEOUT", sampledAt: "2026-01-01T00:00:00Z", id: "a" },
			{ slotKey: "s1", status: "VALID", sampledAt: "2026-01-01T01:00:00Z", id: "b" },
			{ slotKey: "s1", status: "VALID", sampledAt: "2026-01-01T02:00:00Z", id: "c" },
			{ slotKey: "s2", status: "RATE_LIMITED", sampledAt: "2026-01-01T00:00:00Z", id: "d" },
		]);
		expect(counted.map((sample) => sample.id).sort()).toEqual(["c", "d"]);
		expect(counted.filter((sample) => countsAsValidSample(sample.status))).toHaveLength(1);
	});

	it("keeps an earlier valid sample over a later failed re-sample", () => {
		const [kept] = pickCountedSamples([
			{ slotKey: "s1", status: "VALID", sampledAt: "2026-01-01T00:00:00Z", id: "a" },
			{ slotKey: "s1", status: "FAILED", sampledAt: "2026-01-02T00:00:00Z", id: "b" },
		]);
		expect(kept.id).toBe("a");
	});

	it("does not turn an all-unavailable batch into zero valid samples with a rate", () => {
		const counts = summarizeBatch(["CAPTCHA", "UNAVAILABLE", "RATE_LIMITED", "NETWORK_ERROR"]);
		expect(counts).toMatchObject({ planned: 4, valid: 0, unavailable: 2, failed: 2, pending: 0 });
		expect(deriveBatchStatus("RUNNING", counts)).toBe("FAILED");
	});
});

describe("batch status", () => {
	it("stays running while any slot is pending and settles once all are terminal", () => {
		expect(deriveBatchStatus("RUNNING", summarizeBatch(["VALID", "RUNNING"]))).toBe("RUNNING");
		expect(deriveBatchStatus("RUNNING", summarizeBatch(["VALID", "VALID"]))).toBe("COMPLETED");
		expect(deriveBatchStatus("RUNNING", summarizeBatch(["VALID", "TIMEOUT"]))).toBe("PARTIAL");
	});

	it("leaves a paused batch paused", () => {
		expect(deriveBatchStatus("PAUSED", summarizeBatch(["VALID", "VALID"]))).toBe("PAUSED");
	});
});
