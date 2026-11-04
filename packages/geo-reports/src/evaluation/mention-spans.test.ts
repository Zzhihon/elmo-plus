import type { GeoDictionarySnapshot } from "@workspace/geo-domain";
import { describe, expect, it } from "vitest";
import { findMentionRanges, splitAnswerByMentions } from "./mention-spans";

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
		{ ...entity, id: "own", kind: "OWN", displayName: "示例电气", shortName: "示例", aliases: [] },
		{ ...entity, id: "rival", kind: "COMPETITOR", displayName: "示例科技", shortName: null, aliases: [] },
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
	products: [],
};

const marked = (answer: string) =>
	splitAnswerByMentions(answer, findMentionRanges(answer, dictionary))
		.filter((segment) => segment.kind)
		.map((segment) => [segment.kind, segment.text]);

describe("marking brands in an answer", () => {
	it("marks our brand and competitors, with a longer competitor name winning over our short name", () => {
		expect(marked("推荐示例电气，其次是示例科技。")).toEqual([
			["OWN", "示例电气"],
			["COMPETITOR", "示例科技"],
		]);
	});

	it("does not mark a disabled competitor", () => {
		expect(marked("旧品牌也做开关柜")).toEqual([]);
	});

	it("always reassembles to the exact answer, even with overlapping or stale ranges", () => {
		const answer = "首选示例电气";
		const segments = splitAnswerByMentions(answer, [
			{ brandEntityId: "own", kind: "OWN", name: "示例电气", start: 2, end: 6 },
			{ brandEntityId: "rival", kind: "COMPETITOR", name: "示例科技", start: 3, end: 5 },
			{ brandEntityId: "rival", kind: "COMPETITOR", name: "示例科技", start: 5, end: 40 },
		]);
		expect(segments.map((segment) => segment.text).join("")).toBe(answer);
		expect(segments.filter((segment) => segment.kind).map((segment) => segment.entityId)).toEqual(["own"]);
	});
});
