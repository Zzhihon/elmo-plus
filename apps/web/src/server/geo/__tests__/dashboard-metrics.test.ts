import type { GeoRecommendation } from "@workspace/geo-domain";
import type { MetricEvaluation, MetricSample } from "@workspace/geo-reports";
import { describe, expect, it } from "vitest";
import { DEFAULT_DASHBOARD_LAYOUT, moveDashboardCard, normalizeDashboardLayout } from "../dashboard-layout";
import {
	answerSnippet,
	chinaWeekStart,
	ownBrandPosition,
	pickHeadlineCells,
	rateChange,
	shareOfVoice,
	weeklyMentionRate,
} from "../dashboard-metrics";

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
		roundStartedAt: "2026-10-05T00:00:00.000Z",
		promptId: "p1",
		questionText: "广州配电柜厂家推荐",
		promptPriority: "P1",
		platform: "doubao",
		surfaceMode: "LIVE_SURFACE",
		targetId: "t1",
		region: "CN",
		language: "zh-CN",
		promptSetId: "set1",
		promptSetVersion: 1,
		status: "VALID",
		sampledAt: "2026-10-06T02:00:00.000Z",
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

describe("headline platform figures", () => {
	it("uses the most realistic capture mode that has answers, one per platform", () => {
		const picked = pickHeadlineCells([
			{ platform: "doubao", surfaceMode: "MODEL_API", evaluatedSamples: 40 },
			{ platform: "doubao", surfaceMode: "MANUAL_EVIDENCE", evaluatedSamples: 3 },
			{ platform: "deepseek", surfaceMode: "LIVE_SURFACE", evaluatedSamples: 0 },
			{ platform: "deepseek", surfaceMode: "MODEL_API", evaluatedSamples: 12 },
			{ platform: "qwen", surfaceMode: "LIVE_SURFACE", evaluatedSamples: 8 },
			{ platform: "qwen", surfaceMode: "MANUAL_EVIDENCE", evaluatedSamples: 8 },
		]);
		expect(picked.map((cell) => `${cell.platform}:${cell.surfaceMode}`)).toEqual([
			"doubao:MANUAL_EVIDENCE",
			"deepseek:MODEL_API",
			"qwen:LIVE_SURFACE",
		]);
	});

	it("reports no change when the previous period has nothing to compare", () => {
		const current = { status: "OK", numerator: 5, denominator: 10, rate: 0.5, lowSample: true } as const;
		expect(rateChange(current, undefined)).toBeNull();
		expect(rateChange(current, { status: "NO_DATA", numerator: 0, denominator: 0, reason: "" })).toBeNull();
		expect(rateChange(current, { status: "OK", numerator: 3, denominator: 10, rate: 0.3, lowSample: true })).toBe(20);
	});
});

describe("our position among the brands an answer names", () => {
	it("counts each brand once, by where it is first named", () => {
		expect(
			ownBrandPosition([
				{ kind: "COMPETITOR", start: 5, entityId: "c1", text: "甲" },
				{ kind: "COMPETITOR", start: 40, entityId: "c1", text: "甲" },
				{ kind: "BRAND", start: 60, text: "我们" },
				{ kind: "COMPETITOR", start: 80, entityId: "c2", text: "乙" },
				{ kind: "RANK", start: 1, text: "1." },
			]),
		).toBe(2);
	});

	it("is unknown when we are not named", () => {
		expect(ownBrandPosition([{ kind: "COMPETITOR", start: 0, entityId: "c1", text: "甲" }])).toBeNull();
	});
});

describe("weekly exposure", () => {
	it("leaves failed answers out instead of counting them as not mentioned", () => {
		const points = weeklyMentionRate([
			sample({ evaluation: { brandMentioned: true } }),
			sample({ status: "FAILED", evaluation: null }),
			sample({ status: "CAPTCHA", evaluation: null }),
		]);
		expect(points).toHaveLength(1);
		expect(points[0]?.mentionRate).toMatchObject({ status: "OK", numerator: 1, denominator: 1 });
	});

	it("groups by China-time week starting Monday", () => {
		expect(chinaWeekStart("2026-10-11T17:00:00.000Z")).toBe("2026-10-12");
		expect(chinaWeekStart("2026-10-11T15:00:00.000Z")).toBe("2026-10-05");
	});
});

describe("share of voice", () => {
	it("splits brand mentions between us and each competitor", () => {
		const hit = (entityId: string) => ({
			entityId,
			name: entityId,
			mentioned: true,
			recommendation: "MENTIONED_ONLY" as const,
		});
		const evaluated = [
			sample({ evaluation: { brandMentioned: true, competitorHits: [hit("c1")] } }),
			sample({ evaluation: { brandMentioned: false, competitorHits: [hit("c1"), hit("c2")] } }),
		] as (MetricSample & { evaluation: MetricEvaluation })[];
		const shares = shareOfVoice(
			evaluated,
			[
				{ entityId: "c1", name: "竞品甲" },
				{ entityId: "c2", name: "竞品乙" },
			],
			"我们",
		);
		expect(shares.map((entry) => [entry.name, entry.mentions, entry.share])).toEqual([
			["竞品甲", 2, 0.5],
			["我们", 1, 0.25],
			["竞品乙", 1, 0.25],
		]);
	});
});

describe("answer snippet", () => {
	it("marks our brand and competitors inside the excerpt", () => {
		const text = "推荐以下几家：甲电气、我们公司、乙开关。";
		const snippet = answerSnippet(text, [
			{ kind: "COMPETITOR", start: 7, end: 10 },
			{ kind: "BRAND", start: 11, end: 15 },
		]);
		expect(snippet.parts.filter((part) => part.mark).map((part) => [part.text, part.mark])).toEqual([
			["甲电气", "competitor"],
			["我们公司", "own"],
		]);
		expect(snippet.parts.map((part) => part.text).join("")).toBe(text);
		expect(snippet.cutBefore).toBe(false);
	});
});

describe("dashboard layout", () => {
	it("falls back to the default only when nothing was saved", () => {
		expect(normalizeDashboardLayout(null)).toEqual(DEFAULT_DASHBOARD_LAYOUT);
		expect(normalizeDashboardLayout([])).toEqual([]);
	});

	it("drops retired and repeated cards", () => {
		expect(
			normalizeDashboardLayout([{ type: "trend" }, { type: "retired" }, { type: "trend" }, { type: "exposure" }]),
		).toEqual([
			{ id: "trend", type: "trend" },
			{ id: "exposure", type: "exposure" },
		]);
	});

	it("moves a card within bounds", () => {
		const cards = normalizeDashboardLayout([{ type: "trend" }, { type: "exposure" }]);
		expect(moveDashboardCard(cards, "exposure", -1).map((card) => card.type)).toEqual(["exposure", "trend"]);
		expect(moveDashboardCard(cards, "trend", -1).map((card) => card.type)).toEqual(["trend", "exposure"]);
	});
});
