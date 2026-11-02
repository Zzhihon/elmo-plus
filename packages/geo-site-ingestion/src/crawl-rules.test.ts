import { describe, expect, it } from "vitest";
import { backoffMs, classifyStatus, minIntervalMs } from "./crawl-policy";
import { accuracyByField, accuracyOf, drawSample, keyUrlCoverage, sampleSizeFor } from "./qa";
import { isWithinWindow, lastCronFireBetween } from "./schedule";
import { checkSourceUrls } from "./source-config";

describe("crawl politeness", () => {
	it("never goes faster than configured, nor past two requests a second, and honours crawl-delay", () => {
		expect(minIntervalMs(1, null)).toBe(1000);
		expect(minIntervalMs(50, null)).toBe(500);
		expect(minIntervalMs(1, 5)).toBe(5000);
	});

	it("backs off exponentially within a cap and respects a longer Retry-After", () => {
		expect([1, 2, 3].map((attempt) => backoffMs(attempt))).toEqual([2000, 4000, 8000]);
		expect(backoffMs(20)).toBe(60_000);
		expect(backoffMs(1, "30")).toBe(30_000);
		expect(backoffMs(1, "9999")).toBe(120_000);
	});

	it("tells a vanished page from one that wants credentials", () => {
		expect(classifyStatus(404).kind).toBe("GONE");
		expect(classifyStatus(410).kind).toBe("GONE");
		expect(classifyStatus(401).kind).toBe("AUTH_REQUIRED");
		expect(classifyStatus(403).kind).toBe("AUTH_REQUIRED");
		expect(classifyStatus(429)).toMatchObject({ kind: "RETRYABLE" });
		expect(classifyStatus(503)).toMatchObject({ kind: "RETRYABLE", outcome: "SERVER_ERROR" });
		expect(classifyStatus(400).kind).toBe("CLIENT_ERROR");
	});
});

describe("source configuration", () => {
	it("refuses every URL outside the authorized hosts instead of dropping it", () => {
		const checked = checkSourceUrls({
			baseUrl: "http://www.example-electric.test/",
			allowedHosts: ["www.example-electric.test"],
			seedUrls: ["http://www.example-electric.test/products.html", "http://192.168.1.10/", "https://evil.test/"],
			keyUrls: ["javascript:alert(1)"],
		});
		expect(checked.seedUrls).toEqual(["http://www.example-electric.test/products.html"]);
		expect(checked.refused.map((entry) => [entry.field, entry.reason])).toEqual([
			["seedUrls", "IP_LITERAL"],
			["seedUrls", "HOST_NOT_ALLOWED"],
			["keyUrls", "PROTOCOL"],
		]);
	});
});

describe("schedule", () => {
	it("finds the last daily fire in the site's time zone", () => {
		const fire = lastCronFireBetween(
			"0 3 * * *",
			new Date("2026-11-01T00:00:00Z"),
			new Date("2026-11-02T20:00:00Z"),
			"Asia/Shanghai",
		);
		expect(fire?.toISOString()).toBe("2026-11-02T19:00:00.000Z");
		expect(
			lastCronFireBetween("0 3 * * *", fire as Date, new Date("2026-11-03T18:59:00Z"), "Asia/Shanghai"),
		).toBeNull();
	});

	it("handles an operating window that crosses midnight", () => {
		const window = { timezone: "Asia/Shanghai", days: [], start: "22:00", end: "06:00" };
		expect(isWithinWindow(window, new Date("2026-11-02T15:30:00Z"))).toBe(true);
		expect(isWithinWindow(window, new Date("2026-11-02T04:00:00Z"))).toBe(false);
		expect(isWithinWindow(null, new Date())).toBe(true);
	});
});

describe("quality sampling", () => {
	const pages = Array.from({ length: 80 }, (_, index) => ({ id: `page-${index}` }));

	it("samples at least 30 pages, or all of them when fewer", () => {
		expect(sampleSizeFor(80)).toBe(30);
		expect(sampleSizeFor(12)).toBe(12);
		expect(sampleSizeFor(80, 50)).toBe(50);
		expect(sampleSizeFor(80, 5)).toBe(30);
	});

	it("draws the same sample for the same seed and a different one otherwise", () => {
		const first = drawSample(pages, 30, "seed-a").map((page) => page.id);
		expect(drawSample(pages, 30, "seed-a").map((page) => page.id)).toEqual(first);
		expect(new Set(first).size).toBe(30);
		expect(drawSample(pages, 30, "seed-b").map((page) => page.id)).not.toEqual(first);
	});

	it("counts accuracy over judged fields only", () => {
		const result = accuracyOf(["CORRECT", "CORRECT", "INCORRECT", "NOT_APPLICABLE", null]);
		expect(result).toMatchObject({ correct: 2, incorrect: 1, notApplicable: 1, pending: 1 });
		expect(result.accuracy).toBeCloseTo(2 / 3);
		expect(accuracyOf([null, "NOT_APPLICABLE"]).accuracy).toBeNull();
		expect(
			accuracyByField([
				{ fieldPath: "title", verdict: "CORRECT" },
				{ fieldPath: "model", verdict: "INCORRECT" },
			]).model.accuracy,
		).toBe(0);
	});

	it("measures key URL coverage against the confirmed list", () => {
		expect(keyUrlCoverage(["a", "b", "b", "c"], new Set(["a", "c"]))).toEqual({
			total: 3,
			covered: 2,
			ratio: 2 / 3,
			missing: ["b"],
		});
		expect(keyUrlCoverage([], new Set()).ratio).toBeNull();
	});
});
