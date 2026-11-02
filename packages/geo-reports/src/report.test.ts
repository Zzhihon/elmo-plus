import { describe, expect, it } from "vitest";
import { toCsv } from "./csv";
import { unattributedClaimProblem } from "./report";

describe("CSV export", () => {
	it("neutralises cells a spreadsheet would run as a formula, including full-width signs", () => {
		const csv = toCsv([
			["域名", "说明"],
			['=HYPERLINK("http://x.test")', "+cmd"],
			["＝1+1", "@SUM(A1)"],
			["-2", "\tleading tab"],
		]);
		const lines = csv.replace(/^﻿/, "").trim().split("\r\n");
		expect(lines[1]).toBe(`"'=HYPERLINK(""http://x.test"")",'+cmd`);
		expect(lines[2]).toBe("'＝1+1,'@SUM(A1)");
		expect(lines[3]).toBe("'-2,'\tleading tab");
	});

	it("starts with a BOM so the Chinese opens correctly", () => {
		expect(toCsv([["品牌提及率"]]).startsWith("﻿品牌提及率")).toBe(true);
	});
});

describe("report wording", () => {
	it("rejects claims that the work raised orders or revenue", () => {
		expect(unattributedClaimProblem("优化后订单显著增长")).not.toBeNull();
		expect(unattributedClaimProblem("内容发布带来了更多订单")).not.toBeNull();
		expect(unattributedClaimProblem("销售额提升明显")).not.toBeNull();
	});

	it("allows describing inputs and visibility", () => {
		expect(unattributedClaimProblem("本期发布 3 篇选型指南，品牌提及率观察到上升。")).toBeNull();
	});
});
