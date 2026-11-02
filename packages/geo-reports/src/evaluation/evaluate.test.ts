import type { GeoDictionarySnapshot } from "@workspace/geo-domain";
import { describe, expect, it } from "vitest";
import { dictionaryTerms, findAliasHits } from "./alias-match";
import { evaluateWithRules, finalizeEvaluation } from "./evaluate";

const entity = {
	legalName: null,
	historicalNames: [],
	domains: [],
	officialUrl: null,
	regions: [],
	status: "ACTIVE" as const,
	factStatus: "UNVERIFIED" as const,
};

const dictionary: GeoDictionarySnapshot = {
	entities: [
		{
			...entity,
			id: "own",
			kind: "OWN",
			displayName: "示例电气",
			shortName: "示例",
			aliases: ["SL Electric"],
			domains: ["www.example-electric.test"],
		},
		{ ...entity, id: "rival", kind: "COMPETITOR", displayName: "示例科技", shortName: null, aliases: [] },
		{ ...entity, id: "grid", kind: "COMPETITOR", displayName: "华电设备", shortName: "华电", aliases: [] },
		{
			...entity,
			id: "gone",
			kind: "COMPETITOR",
			displayName: "旧品牌",
			shortName: null,
			aliases: [],
			status: "DISABLED",
		},
	],
	products: [
		{
			id: "p1",
			brandEntityId: "own",
			model: "SL-12",
			name: "高低压开关柜",
			category: null,
			termKind: "CUSTOMER_MODEL",
			factStatus: "UNVERIFIED",
			status: "ACTIVE",
		},
	],
};

const terms = dictionaryTerms(dictionary);
const hitsIn = (text: string) => findAliasHits(text, terms).map((hit) => [hit.entityId, hit.text]);

describe("alias matching in Chinese text", () => {
	it("prefers the longer name where a competitor's name contains the brand's short name", () => {
		expect(hitsIn("示例科技的高低压开关柜交付较快")).toEqual([["rival", "示例科技"]]);
		expect(hitsIn("推荐示例电气")).toEqual([["own", "示例电气"]]);
	});

	it("does not let a two-character alias match inside an unrelated longer word", () => {
		expect(hitsIn("中华电力公司负责区域电网")).toEqual([]);
		expect(hitsIn("示例性的说明不代表任何厂家")).toEqual([]);
	});

	it("still finds a short alias that stands on its own", () => {
		expect(hitsIn("华电的柜体做工扎实。")).toEqual([["grid", "华电"]]);
		expect(hitsIn("可以考虑示例，售后响应快")).toEqual([["own", "示例"]]);
		expect(hitsIn("华电集团")).toEqual([["grid", "华电"]]);
	});

	it("matches Latin names on word boundaries regardless of width and case", () => {
		expect(hitsIn("ＳＬ　ＥＬＥＣＴＲＩＣ 提供成套设备")).toEqual([["own", "ＳＬ　ＥＬＥＣＴＲＩＣ"]]);
		expect(hitsIn("BSL Electricity is unrelated")).toEqual([]);
	});

	it("ignores disabled entities and reports spans into the original answer", () => {
		expect(hitsIn("旧品牌已退出市场")).toEqual([]);
		const answer = "前言。\n  示例电气在华南有项目";
		const [hit] = findAliasHits(answer, terms);
		expect(hit && answer.slice(hit.start, hit.end)).toBe("示例电气");
	});
});

describe("rule evaluation", () => {
	const evaluate = (answer: string) => evaluateWithRules({ answer, dictionary, citations: [], approvedAssertions: [] });

	it("reads a ranked shortlist and the brand's position in it", () => {
		const result = evaluate("推荐以下厂家：\n1. 华电设备：老牌企业\n2. 示例电气：交付快\n3. 示例科技：价格低");
		expect(result.hasOrderedList).toBe(true);
		expect(result.brandRank).toBe(2);
		expect(result.recommendation).toBe("RECOMMENDED");
		expect(result.competitorHits.find((hit) => hit.entityId === "grid")?.rank).toBe(1);
	});

	it("does not invent a rank for a list that ranks no known names", () => {
		const result = evaluate("选型要点：\n1. 额定电压\n2. 防护等级\n示例电气可以提供方案。");
		expect(result.hasOrderedList).toBe(false);
		expect(result.brandRank).toBeNull();
	});

	it("treats a negated recommendation as negative", () => {
		expect(evaluate("示例电气不推荐用于高海拔项目。").recommendation).toBe("NEGATIVE");
		expect(evaluate("示例电气在华南有一些项目。").recommendation).toBe("MENTIONED_ONLY");
		expect(evaluate("这些厂家都可以。").recommendation).toBe("NOT_MENTIONED");
	});

	it("extracts and flags a technical claim about the brand's own product", () => {
		const result = evaluate("示例电气的 SL-12 额定电压为 12kV。");
		expect(result.claims.map((claim) => [claim.kind, claim.value, claim.matchStatus])).toEqual([
			["NUMBER", "12kv", "NO_REFERENCE"],
			["MODEL", "SL-12", "MATCHED"],
		]);
	});

	it("compares a number with approved knowledge without calling a mismatch an error", () => {
		const result = evaluateWithRules({
			answer: "示例电气的 SL-12 额定电压为 24kV。",
			dictionary,
			citations: [],
			approvedAssertions: [{ id: "a1", claimText: "SL-12 额定电压 12kV", normalizedValue: "12kV" }],
		});
		const number = result.claims.find((claim) => claim.kind === "NUMBER");
		expect(number?.matchStatus).toBe("MISMATCH");
		expect(number?.verdict).toBe("UNVERIFIED");
		expect(number?.referenceValue).toBe("12kv");
	});
});

describe("review routing", () => {
	const rules = evaluateWithRules({
		answer: "首选示例电气。",
		dictionary,
		citations: [{ ordinal: 0, url: "https://news.example-electric.test/a?utm_source=x" }],
		approvedAssertions: [],
	});

	it("keeps the rules' result when the model disagrees and sends it to review", () => {
		const final = finalizeEvaluation(
			rules,
			{
				model: "m",
				brandMentioned: true,
				recommendation: "MENTIONED_ONLY",
				hasOrderedList: false,
				brandRank: null,
				confidence: 0.9,
				evidenceQuote: null,
				quoteFound: false,
			},
			"P3",
		);
		expect(final.recommendation).toBe("RECOMMENDED");
		expect(final.reviewStatus).toBe("PENDING_REVIEW");
		expect(final.reviewReasons).toContain("LLM_DISAGREES");
	});

	it("never auto-accepts a recommendation that only the rules made", () => {
		expect(finalizeEvaluation(rules, null, "P3").reviewReasons).toEqual(["RULES_ONLY_JUDGEMENT"]);
	});

	it("sends high-priority questions to review even when everything agrees", () => {
		const plain = evaluateWithRules({
			answer: "示例电气在华南有项目。",
			dictionary,
			citations: [],
			approvedAssertions: [],
		});
		expect(finalizeEvaluation(plain, null, "P3").reviewStatus).toBe("AUTO_ACCEPTED");
		const final = finalizeEvaluation(plain, null, "P0");
		expect(final.reviewReasons).toEqual(["HIGH_PRIORITY_PROMPT"]);
		expect(final.reviewPriority).toBeGreaterThan(finalizeEvaluation(rules, null, "P3").reviewPriority);
	});

	it("attributes a cited subdomain to the brand that owns the domain", () => {
		expect(rules.citationAttribution).toEqual([
			expect.objectContaining({ owner: "OWN", entityId: "own", host: "news.example-electric.test" }),
		]);
	});
});
