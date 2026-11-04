import type {
	GeoCitationAttribution,
	GeoCitedContentType,
	GeoObservationStatus,
	GeoPlatform,
	GeoSurfaceMode,
} from "@workspace/geo-domain";
import { describe, expect, it } from "vitest";
import type { MetricSample } from "../metrics";
import { classifyCitationByRules } from "./classify";
import { compareBrands } from "./comparison";
import {
	type ExistingRecommendation,
	generateRecommendations,
	type RecommendationCitation,
	type RecommendationInput,
	reconcileRecommendations,
} from "./generate";

let counter = 0;

const COMPETITORS = [
	{ entityId: "c1", name: "竞品甲" },
	{ entityId: "c2", name: "竞品乙" },
];

function answer(
	options: {
		promptId?: string;
		platform?: GeoPlatform;
		surfaceMode?: GeoSurfaceMode;
		status?: GeoObservationStatus;
		usMentioned?: boolean;
		competitors?: string[];
		cites?: { url: string; owner: GeoCitationAttribution["owner"]; entityId?: string }[];
	} = {},
): { sample: MetricSample; citations: RecommendationCitation[] } {
	counter++;
	const id = `o${counter}`;
	const cites = options.cites ?? [];
	return {
		sample: {
			observationId: id,
			slotKey: `slot${counter}`,
			roundKey: "batch:b1",
			roundStartedAt: "2026-10-01T00:00:00.000Z",
			promptId: options.promptId ?? "p1",
			questionText: "KYN28 开关柜哪家厂家好",
			promptPriority: "P1",
			platform: options.platform ?? "deepseek",
			surfaceMode: options.surfaceMode ?? "MODEL_API",
			targetId: "t1",
			region: "CN",
			language: "zh-CN",
			promptSetId: "set1",
			promptSetVersion: 1,
			status: options.status ?? "VALID",
			sampledAt: `2026-10-01T00:00:${String(counter % 60).padStart(2, "0")}.000Z`,
			claims: [],
			evaluation: {
				evaluationId: `e${counter}`,
				version: 1,
				evaluatorVersion: "rules-v1",
				brandMentioned: options.usMentioned ?? false,
				recommendation: options.usMentioned ? "MENTIONED_ONLY" : "NOT_MENTIONED",
				hasOrderedList: false,
				brandRank: null,
				competitorHits: (options.competitors ?? ["c1"]).map((entityId) => ({
					entityId,
					mentioned: true,
					recommendation: "RECOMMENDED",
				})),
				citations: cites.map((cite, index) => ({
					ordinal: index,
					normalizedUrl: cite.url,
					host: null,
					owner: cite.owner,
					entityId: cite.entityId ?? null,
				})),
				reviewStatus: "AUTO_ACCEPTED",
			},
		},
		citations: cites.map((cite, index) => ({ observationId: id, ordinal: index, url: cite.url, title: null })),
	};
}

function input(
	answers: ReturnType<typeof answer>[],
	overrides: Partial<RecommendationInput> = {},
	classifications: Record<string, GeoCitedContentType> = {},
): RecommendationInput {
	return {
		samples: answers.map((entry) => entry.sample),
		competitors: COMPETITORS,
		prompts: new Map([
			[
				"p1",
				{
					promptId: "p1",
					questionText: "KYN28 开关柜哪家厂家好",
					priority: "P1",
					buyerRoleTitle: "采购负责人",
					buyerRolePriority: 3,
					productLine: "中压开关柜",
				},
			],
		]),
		citations: answers.flatMap((entry) => entry.citations),
		classifications: new Map(Object.entries(classifications)),
		siteContent: [],
		ownProducts: [{ name: "KYN28 铠装移开式金属封闭开关设备", model: "KYN28" }],
		findings: [],
		claims: [],
		...overrides,
	};
}

const SPEC = "https://rival.example.com/product/kyn28.html";

function lostRound(platform: GeoPlatform = "deepseek", status: GeoObservationStatus = "VALID") {
	return [1, 2, 3].map(() => answer({ platform, status, cites: [{ url: SPEC, owner: "COMPETITOR", entityId: "c1" }] }));
}

describe("content gaps", () => {
	it("names our product and the competitor when a question is lost to a cited spec page we do not have", () => {
		const drafts = generateRecommendations(input(lostRound(), {}, { [SPEC]: "PRODUCT_SPEC" }));
		const gap = drafts.find((draft) => draft.kind === "CONTENT_GAP");
		expect(gap?.subjectKey).toBe("PRODUCT_SPEC:kyn28");
		expect(gap?.title).toContain("KYN28");
		expect(gap?.summary).toContain("竞品甲");
		expect(gap?.summary).toContain("采购负责人");
		expect(gap?.evidence.citedUrls).toEqual([SPEC]);
		expect(gap?.evidence.siteHas?.count).toBe(0);
	});

	it("asks to enrich existing case pages rather than add them when the site already has some", () => {
		const url = "https://rival.example.com/case/1.html";
		const round = [1, 2, 3].map(() => answer({ cites: [{ url, owner: "COMPETITOR", entityId: "c1" }] }));
		const without = generateRecommendations(input(round, {}, { [url]: "CASE_STUDY" }));
		const withCases = generateRecommendations(
			input(
				round,
				{ siteContent: [{ contentType: "CASE_STUDY", title: "某园区配电工程", pageId: "pg1", url: null }] },
				{ [url]: "CASE_STUDY" },
			),
		);
		const titleOf = (drafts: typeof without) => drafts.find((draft) => draft.contentType === "CASE_STUDY")?.title;
		expect(titleOf(without)).toBe("补充可核实的成功交付案例");
		expect(titleOf(withCases)).toContain("充实现有案例");
	});

	it("ignores failed samples, however many competitors they name", () => {
		const drafts = generateRecommendations(input(lostRound("deepseek", "FAILED"), {}, { [SPEC]: "PRODUCT_SPEC" }));
		expect(drafts.filter((draft) => draft.kind === "CONTENT_GAP")).toEqual([]);
	});

	it("weighs a question lost on more platforms higher", () => {
		const one = generateRecommendations(input(lostRound("deepseek"), {}, { [SPEC]: "PRODUCT_SPEC" }));
		const four = generateRecommendations(
			input(
				[...lostRound("deepseek"), ...lostRound("doubao"), ...lostRound("qwen"), ...lostRound("yuanbao")],
				{},
				{ [SPEC]: "PRODUCT_SPEC" },
			),
		);
		const gapOf = (drafts: typeof one) => drafts.find((draft) => draft.kind === "CONTENT_GAP");
		expect(gapOf(one)?.priority).toBe("P2");
		expect(gapOf(four)?.priority).toBe("P0");
		expect(gapOf(four)?.evidence.measure).toBe(4);
	});
});

describe("third-party channels", () => {
	const ZHIHU = "https://www.zhihu.com/question/1";

	it("needs at least two lost answers citing the platform", () => {
		const once = [answer({ cites: [{ url: ZHIHU, owner: "THIRD_PARTY" }] }), answer(), answer()];
		const twice = [
			answer({ cites: [{ url: ZHIHU, owner: "THIRD_PARTY" }] }),
			answer({ cites: [{ url: `${ZHIHU}/answer/2`, owner: "THIRD_PARTY" }] }),
			answer(),
		];
		const types = { [ZHIHU]: "QA_COMMUNITY", [`${ZHIHU}/answer/2`]: "QA_COMMUNITY" } as const;
		expect(generateRecommendations(input(once, {}, types)).some((d) => d.kind === "THIRD_PARTY_CHANNEL")).toBe(false);
		const channel = generateRecommendations(input(twice, {}, types)).find((d) => d.kind === "THIRD_PARTY_CHANNEL");
		expect(channel?.subjectKey).toBe("zhihu.com");
		expect(channel?.title).toContain("知乎");
	});

	it("stays quiet about a platform that already cites us", () => {
		const answers = [
			answer({ cites: [{ url: ZHIHU, owner: "THIRD_PARTY" }] }),
			answer({ cites: [{ url: ZHIHU, owner: "THIRD_PARTY" }] }),
			answer(),
			answer({ promptId: "p2", usMentioned: true, cites: [{ url: ZHIHU, owner: "THIRD_PARTY" }] }),
		];
		const drafts = generateRecommendations(input(answers, {}, { [ZHIHU]: "QA_COMMUNITY" }));
		expect(drafts.some((draft) => draft.kind === "THIRD_PARTY_CHANNEL")).toBe(false);
	});
});

describe("site fixes and wrong claims", () => {
	it("groups open findings by rule with the number of pages affected", () => {
		const finding = (id: string, pageId: string) => ({
			id,
			ruleId: "content.image_only",
			ruleTitle: "详情页只有图片没有文字",
			recommendation: "补充文字说明",
			severity: "HIGH" as const,
			pageId,
			pageUrl: null,
		});
		const drafts = generateRecommendations(
			input([], { findings: [finding("f1", "a"), finding("f2", "b"), finding("f3", "c"), finding("f4", "d")] }),
		);
		expect(drafts).toHaveLength(1);
		expect(drafts[0]?.summary).toContain("4 个页面");
		expect(drafts[0]?.evidence.findingIds).toHaveLength(4);
	});

	it("reports a wrong claim only from valid answers", () => {
		const valid = answer({ usMentioned: true });
		const failed = answer({ usMentioned: true, status: "TIMEOUT" });
		const claim = (id: string, observationId: string) => ({
			id,
			observationId,
			claimText: "额定电压 10kV",
			kind: "NUMBER" as const,
			extractedValue: "10kv",
			referenceValue: "12kv",
			verdict: "ERROR" as const,
			matchStatus: "MISMATCH" as const,
			assertionId: "a1",
		});
		const drafts = generateRecommendations(
			input([valid, failed], {
				claims: [claim("k1", valid.sample.observationId), claim("k2", failed.sample.observationId)],
			}),
		);
		const fact = drafts.find((draft) => draft.kind === "FACT_CORRECTION");
		expect(fact?.evidence.observationIds).toEqual([valid.sample.observationId]);
		expect(fact?.summary).toContain("12kv");
	});
});

describe("regeneration", () => {
	const draft = (measure: number) =>
		generateRecommendations(
			input(
				Array.from({ length: measure }, (_, index) =>
					lostRound((["deepseek", "doubao", "qwen", "yuanbao"] as const)[index] ?? "deepseek"),
				).flat(),
				{},
				{ [SPEC]: "PRODUCT_SPEC" },
			),
		).filter((entry) => entry.kind === "CONTENT_GAP");
	const existing = (status: ExistingRecommendation["status"], decidedMeasure: number): ExistingRecommendation => ({
		id: "r1",
		kind: "CONTENT_GAP",
		subjectKey: "PRODUCT_SPEC:kyn28",
		status,
		taskId: null,
		evidence: { measure: decidedMeasure, decidedMeasure },
	});

	it("keeps a dismissed item dismissed while the evidence grows only a little", () => {
		const { writes } = reconcileRecommendations([existing("DISMISSED", 2)], draft(3));
		expect(writes[0]?.status).toBe("DISMISSED");
		expect(writes[0]?.draft.evidence.decidedMeasure).toBe(2);
	});

	it("reopens a dismissed or converted item once the evidence doubles", () => {
		expect(reconcileRecommendations([existing("DISMISSED", 2)], draft(4)).writes[0]).toMatchObject({
			status: "OPEN",
			reopened: true,
		});
		expect(reconcileRecommendations([existing("CONVERTED", 1)], draft(3)).writes[0]?.status).toBe("OPEN");
	});

	it("removes open items the evidence no longer supports and keeps decided ones", () => {
		const { staleIds } = reconcileRecommendations(
			[existing("OPEN", 1), { ...existing("DISMISSED", 1), id: "r2", subjectKey: "CASE_STUDY" }],
			[],
		);
		expect(staleIds).toEqual(["r1"]);
	});
});

describe("citation rules", () => {
	it("reads well-known platforms and site sections without asking a model", () => {
		expect(classifyCitationByRules("https://zhuanlan.zhihu.com/p/1")).toBe("QA_COMMUNITY");
		expect(classifyCitationByRules("https://baijiahao.baidu.com/s?id=1")).toBe("MEDIA_ARTICLE");
		expect(classifyCitationByRules("https://detail.1688.com/offer/1.html")).toBe("DIRECTORY_LISTING");
		expect(classifyCitationByRules("https://www.rival.cn/case/12.html")).toBe("CASE_STUDY");
		expect(classifyCitationByRules("https://www.rival.cn/a/12.html", "KYN28 技术参数")).toBe("PRODUCT_SPEC");
		expect(classifyCitationByRules("https://www.rival.cn/a/12.html", "首页")).toBeNull();
	});
});

describe("competitor comparison", () => {
	it("keeps each surface mode apart", () => {
		const answers = [
			answer({ surfaceMode: "MODEL_API", usMentioned: true }),
			answer({ surfaceMode: "MODEL_API" }),
			answer({ surfaceMode: "LIVE_SURFACE", competitors: [] }),
		];
		const result = compareBrands({
			samples: answers.map((entry) => entry.sample),
			competitors: COMPETITORS,
			ownName: "我们",
			citations: [],
			classifications: new Map(),
		});
		const api = result.find((mode) => mode.surfaceMode === "MODEL_API");
		const live = result.find((mode) => mode.surfaceMode === "LIVE_SURFACE");
		expect(api?.rows.find((row) => row.entityId === null)?.mentionRate).toBe(0.5);
		expect(api?.rows.find((row) => row.entityId === "c1")?.mentionRate).toBe(1);
		expect(live?.rows.find((row) => row.entityId === "c1")?.mentionRate).toBe(0);
	});
});
