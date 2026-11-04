import { describe, expect, it } from "vitest";
import { type CompetitorAnswer, type CompetitorTally, tallyCompetitorMentions } from "./discovery";

const answer = (id: string, text: string, platform: CompetitorAnswer["platform"] = "doubao"): CompetitorAnswer => ({
	id,
	platform,
	text,
	sampledAt: new Date("2026-10-01T00:00:00Z"),
});

function tally(answers: CompetitorAnswer[], names: string[][], known: string[] = []) {
	const tallies = new Map<string, CompetitorTally>();
	tallyCompetitorMentions(
		tallies,
		answers,
		{ answers: names.map((list, index) => ({ index, companies: list.map((name) => ({ name, domain: null })) })) },
		known,
	);
	return tallies;
}

describe("competitor discovery", () => {
	it("never offers the organization's own brand or a known competitor, under any spelling", () => {
		const tallies = tally(
			[answer("o1", "推荐示例电气、广州示例电气有限公司和样本开关。")],
			[["示例电气", "广州示例电气有限公司", "样本开关"]],
			["示例电气"],
		);
		expect([...tallies.values()].map((row) => row.name)).toEqual(["样本开关"]);
	});

	it("drops a name the answer does not actually contain", () => {
		const tallies = tally([answer("o1", "可以考虑样本开关。")], [["样本开关", "虚构电器"]]);
		expect([...tallies.keys()]).toEqual(["样本开关"]);
	});

	it("counts every mention and every answer and platform that named the company", () => {
		const tallies = tally(
			[answer("o1", "样本开关质量好，样本开关交货快。"), answer("o2", "样本开关", "deepseek")],
			[["样本开关"], ["样本开关"]],
		);
		expect(tallies.get("样本开关")).toMatchObject({
			mentionCount: 3,
			observationIds: ["o1", "o2"],
			platforms: ["doubao", "deepseek"],
		});
	});
});
