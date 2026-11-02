import type { GeoObservationStatus, GeoRecommendation } from "@workspace/geo-domain";
import { describe, expect, it } from "vitest";
import { compareBatches } from "./compare";
import { computeInsights } from "./insights";
import {
	computeCellMetrics,
	equalWeightSummary,
	formatMetric,
	type MetricEvaluation,
	type MetricSample,
	type PlannedSlot,
	validSampleRate,
} from "./metrics";

let counter = 0;

function sample(
	overrides: Omit<Partial<MetricSample>, "evaluation"> & { evaluation?: Partial<MetricEvaluation> | null } = {},
): MetricSample {
	counter++;
	const { evaluation, ...rest } = overrides;
	return {
		observationId: `o${counter}`,
		slotKey: `slot${counter}`,
		roundKey: "batch:b1",
		roundStartedAt: "2026-10-01T00:00:00.000Z",
		promptId: "p1",
		questionText: "高低压开关柜供应商怎么选",
		promptPriority: "P2",
		platform: "deepseek",
		surfaceMode: "MODEL_API",
		targetId: "t1",
		region: "CN",
		language: "zh-CN",
		promptSetId: "set1",
		promptSetVersion: 1,
		status: "VALID",
		sampledAt: `2026-10-01T00:00:${String(counter % 60).padStart(2, "0")}.000Z`,
		claims: [],
		...rest,
		evaluation:
			evaluation === null
				? null
				: {
						evaluationId: `e${counter}`,
						version: 1,
						evaluatorVersion: "rules-v1",
						brandMentioned: false,
						recommendation: "NOT_MENTIONED" as GeoRecommendation,
						hasOrderedList: false,
						brandRank: null,
						competitorHits: [],
						citations: [],
						reviewStatus: "AUTO_ACCEPTED",
						...evaluation,
					},
	};
}

const mentioned = { brandMentioned: true, recommendation: "MENTIONED_ONLY" as GeoRecommendation };

function cell(samples: MetricSample[], slots: PlannedSlot[] = []) {
	return computeCellMetrics({
		platform: "deepseek",
		surfaceMode: "MODEL_API",
		samples,
		slots,
		competitors: [
			{ entityId: "c1", name: "竞品甲" },
			{ entityId: "c2", name: "竞品乙" },
		],
	});
}

function slot(status: PlannedSlot["status"], key = `s${++counter}`): PlannedSlot {
	return { slotKey: key, platform: "deepseek", surfaceMode: "MODEL_API", status, sampledAt: "2026-10-01T00:00:00Z" };
}

describe("valid sample rate", () => {
	it("is valid over planned, with refusals, rate limits, failures and pending runs kept apart", () => {
		const result = validSampleRate([
			slot("VALID"),
			slot("VALID"),
			slot("UNAVAILABLE"),
			slot("CAPTCHA"),
			slot("RATE_LIMITED"),
			slot("TIMEOUT"),
			slot("PARTIAL"),
			slot("RUNNING"),
		]);
		expect(result.value).toMatchObject({ status: "OK", numerator: 2, denominator: 8 });
		expect(result.breakdown).toMatchObject({ refused: 2, rateLimited: 1, failed: 1, partial: 1, pending: 1 });
	});

	it("counts a slot once when a failed run was re-sampled successfully", () => {
		const result = validSampleRate([slot("FAILED", "x"), { ...slot("VALID", "x"), sampledAt: "2026-10-02T00:00:00Z" }]);
		expect(result.value).toMatchObject({ numerator: 1, denominator: 1 });
	});
});

describe("mention and recommendation rates", () => {
	it("leave failed, refused and truncated samples out of the denominator", () => {
		const metrics = cell([
			sample({ evaluation: mentioned }),
			sample(),
			sample({ status: "RATE_LIMITED", evaluation: null }),
			sample({ status: "UNAVAILABLE", evaluation: null }),
			sample({ status: "PARTIAL", evaluation: mentioned }),
		]);
		expect(metrics.mentionRate).toMatchObject({ status: "OK", numerator: 1, denominator: 2 });
	});

	it("count a re-sampled slot once, using its valid sample", () => {
		const metrics = cell([
			sample({ slotKey: "same", status: "TIMEOUT", evaluation: null }),
			sample({ slotKey: "same", evaluation: mentioned }),
		]);
		expect(metrics.mentionRate).toMatchObject({ numerator: 1, denominator: 1 });
	});

	it("shows no data, never 0%, when every source failed", () => {
		const metrics = cell(
			[sample({ status: "UNAVAILABLE", evaluation: null }), sample({ status: "CAPTCHA", evaluation: null })],
			[slot("UNAVAILABLE"), slot("CAPTCHA")],
		);
		expect(metrics.mentionRate.status).toBe("NO_DATA");
		expect(formatMetric(metrics.mentionRate)).toBe("数据不足");
		expect(metrics.validSampleRate.value).toMatchObject({ status: "OK", numerator: 0, denominator: 2 });
		const insights = computeInsights({ samples: [], slots: [slot("FAILED")], competitors: [] });
		expect(insights.noData).toBe(true);
		expect(insights.cells[0]?.mentionRate.status).toBe("NO_DATA");
	});

	it("only counts confirmed recommendations, holding unreviewed ones apart", () => {
		const metrics = cell([
			sample({ evaluation: { brandMentioned: true, recommendation: "RECOMMENDED", reviewStatus: "CONFIRMED" } }),
			sample({ evaluation: { brandMentioned: true, recommendation: "RECOMMENDED", reviewStatus: "PENDING_REVIEW" } }),
			sample({ evaluation: mentioned }),
			sample(),
		]);
		expect(metrics.recommendationRate).toMatchObject({ numerator: 1, denominator: 4 });
		expect(metrics.recommendationsAwaitingReview).toBe(1);
	});

	it("flags a rate over few samples as low-sample", () => {
		expect(cell([sample({ evaluation: mentioned })]).mentionRate).toMatchObject({ lowSample: true });
	});
});

describe("stable mention rate", () => {
	it("needs two of three valid samples per question and round, and sets aside questions with fewer than three", () => {
		const metrics = cell([
			sample({ promptId: "p1", evaluation: mentioned }),
			sample({ promptId: "p1", evaluation: mentioned }),
			sample({ promptId: "p1" }),
			sample({ promptId: "p2", evaluation: mentioned }),
			sample({ promptId: "p2" }),
			sample({ promptId: "p2" }),
			sample({ promptId: "p3", evaluation: mentioned }),
			sample({ promptId: "p3", evaluation: mentioned }),
			sample({ promptId: "p3", status: "FAILED", evaluation: null }),
		]);
		expect(metrics.stableMention).toMatchObject({ stableUnits: 1, sufficientUnits: 2, insufficientUnits: 1 });
		expect(metrics.stableMention.value).toMatchObject({ numerator: 1, denominator: 2 });
	});

	it("reports insufficient samples rather than a rate when no question has three", () => {
		const metrics = cell([sample({ evaluation: mentioned }), sample({ evaluation: mentioned })]);
		expect(metrics.stableMention.value.status).toBe("NO_DATA");
		expect(metrics.stableMention.insufficientUnits).toBe(1);
	});
});

describe("top-three rate", () => {
	it("is computed over answers with a determinable ranked list only", () => {
		const metrics = cell([
			sample({ evaluation: { ...mentioned, hasOrderedList: true, brandRank: 2 } }),
			sample({ evaluation: { ...mentioned, hasOrderedList: true, brandRank: 5 } }),
			sample({ evaluation: { hasOrderedList: true, brandRank: null } }),
			sample({ evaluation: mentioned }),
		]);
		expect(metrics.top3Rate).toMatchObject({ numerator: 1, denominator: 3 });
		expect(cell([sample({ evaluation: mentioned })]).top3Rate.status).toBe("NO_DATA");
	});
});

describe("competitor coverage", () => {
	it("counts each competitor over the same valid set, so shares may add up past 100%", () => {
		const both = [
			{ entityId: "c1", mentioned: true, recommendation: "MENTIONED_ONLY" as GeoRecommendation },
			{ entityId: "c2", mentioned: true, recommendation: "RECOMMENDED" as GeoRecommendation },
		];
		const metrics = cell([
			sample({ evaluation: { competitorHits: both } }),
			sample({ evaluation: { competitorHits: both } }),
		]);
		const [first, second] = metrics.competitors;
		expect(first?.mentioned).toMatchObject({ numerator: 2, denominator: 2 });
		expect(second?.mentioned).toMatchObject({ numerator: 2, denominator: 2 });
		expect(second?.recommended).toMatchObject({ numerator: 2, denominator: 2 });
	});

	it("leaves samples from before a competitor joined the dictionary out of its denominator", () => {
		const oldHit = { entityId: "c1", mentioned: true, recommendation: "MENTIONED_ONLY" as GeoRecommendation };
		const newHit = { entityId: "c2", mentioned: false, recommendation: "NOT_MENTIONED" as GeoRecommendation };
		const metrics = cell([
			sample({ evaluation: { competitorHits: [oldHit] } }),
			sample({ evaluation: { competitorHits: [oldHit] } }),
			sample({ evaluation: { competitorHits: [oldHit, newHit] } }),
		]);
		const [existing, added] = metrics.competitors;
		expect(existing?.mentioned).toMatchObject({ numerator: 3, denominator: 3 });
		expect(added?.mentioned).toMatchObject({ status: "OK", numerator: 0, denominator: 1 });
	});

	it("reads as no data, never 0%, when no sample was evaluated against the competitor yet", () => {
		const metrics = cell([sample({ evaluation: { competitorHits: [] } })]);
		const [added] = metrics.competitors;
		expect(added?.mentioned.status).toBe("NO_DATA");
		expect(added?.recommended.status).toBe("NO_DATA");
		expect(added && formatMetric(added.mentioned)).toBe("数据不足");
	});
});

describe("citation sources", () => {
	it("says not provided when no answer cited anything", () => {
		expect(cell([sample(), sample()]).citations.status).toBe("NOT_PROVIDED");
	});

	it("groups normalised citations by domain and owner", () => {
		const citations = [
			{ ordinal: 0, normalizedUrl: "https://a.test/x", host: "a.test", owner: "OWN" as const, entityId: "own" },
			{ ordinal: 1, normalizedUrl: "https://b.test/y", host: "b.test", owner: "THIRD_PARTY" as const, entityId: null },
			{ ordinal: 2, normalizedUrl: "https://a.test/z", host: "a.test", owner: "OWN" as const, entityId: "own" },
		];
		const result = cell([sample({ evaluation: { citations } }), sample()]).citations;
		expect(result.status).toBe("OK");
		expect(result.byOwner).toEqual({ OWN: 2, COMPETITOR: 0, THIRD_PARTY: 1 });
		expect(result.domains[0]).toMatchObject({ host: "a.test", count: 2, samples: 1 });
		expect(result.samplesWithCitations).toMatchObject({ numerator: 1, denominator: 2 });
	});
});

describe("error description rate", () => {
	it("counts only errors a technical review confirmed, over claims that could be checked", () => {
		const metrics = cell([
			sample({
				claims: [
					{ verdict: "ERROR", matchStatus: "MISMATCH" },
					{ verdict: "CORRECT", matchStatus: "MATCHED" },
					{ verdict: "UNVERIFIED", matchStatus: "MISMATCH" },
					{ verdict: "UNVERIFIED", matchStatus: "NO_REFERENCE" },
				],
			}),
			sample({ status: "FAILED", evaluation: null, claims: [{ verdict: "ERROR", matchStatus: "MISMATCH" }] }),
		]);
		expect(metrics.errorRate).toMatchObject({ confirmedErrors: 1, checkable: 2, awaitingTechReview: 1, unverified: 1 });
		expect(metrics.errorRate.value).toMatchObject({ numerator: 1, denominator: 2 });
		expect(
			cell([sample({ claims: [{ verdict: "UNVERIFIED", matchStatus: "NO_REFERENCE" }] })]).errorRate.value.status,
		).toBe("NO_DATA");
	});
});

describe("platforms are never pooled", () => {
	it("keeps each platform and surface mode in its own cell and labels the equal-weight overview", () => {
		const insights = computeInsights({
			samples: [
				sample({ evaluation: mentioned }),
				sample({ platform: "qwen", surfaceMode: "MANUAL_EVIDENCE" }),
				sample({
					platform: "deepseek",
					surfaceMode: "LIVE_SURFACE",
					status: "FAILED" as GeoObservationStatus,
					evaluation: null,
				}),
			],
			slots: [],
			competitors: [],
		});
		expect(insights.cells.map((entry) => `${entry.platform}|${entry.surfaceMode}`)).toEqual([
			"deepseek|LIVE_SURFACE",
			"deepseek|MODEL_API",
			"qwen|MANUAL_EVIDENCE",
		]);
		expect(insights.overview.mention).toMatchObject({ cellsIncluded: 2, cellsWithoutData: 1, weighting: "EQUAL" });
		expect(insights.overview.mention.value).toMatchObject({ status: "OK", rate: 0.5 });
		expect(equalWeightSummary([], (entry) => entry.mentionRate).value.status).toBe("NO_DATA");
	});
});

describe("batch comparison", () => {
	it("compares only questions both rounds sampled and names any condition that changed", () => {
		const before = [
			sample({ roundKey: "batch:b1", promptId: "p1" }),
			sample({ roundKey: "batch:b1", promptId: "p2", evaluation: mentioned }),
		];
		const after = [
			sample({ roundKey: "batch:b2", promptId: "p1", evaluation: mentioned }),
			sample({ roundKey: "batch:b2", promptId: "p3", evaluation: mentioned }),
		];
		const result = compareBatches({ batchId: "b1", samples: before }, { batchId: "b2", samples: after });
		expect(result.comparedPromptIds).toEqual(["p1"]);
		expect(result.excludedPromptIds).toEqual(["p2", "p3"]);
		expect(result.rows[0]).toMatchObject({ mentionDelta: 100 });
		expect(result.sameConditions).toBe(false);

		const changed = compareBatches(
			{ batchId: "b1", samples: [sample({ promptId: "p1" })] },
			{ batchId: "b2", samples: [sample({ promptId: "p1", evaluation: { evaluatorVersion: "rules-v2" } })] },
		);
		expect(changed.rows[0]?.conditionChanges).toEqual(["评估规则版本"]);
	});
});
