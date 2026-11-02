import { describe, expect, it } from "vitest";
import { type GeoPromptCsvContext, toPromptCsv, validatePromptCsvRows } from "./prompt-csv";

const ROLE_ID = "11111111-1111-4111-8111-111111111111";
const FROZEN_ID = "22222222-2222-4222-8222-222222222222";

const context: GeoPromptCsvContext = {
	roles: new Map([
		["PROCUREMENT_LEAD", ROLE_ID],
		["采购负责人", ROLE_ID],
	]),
	existing: [
		{
			id: FROZEN_ID,
			question: "高低压开关柜供应商怎么比较",
			status: "FROZEN",
			buyerRoleId: ROLE_ID,
			intent: "选型",
			productLine: "=开关柜",
			geoRegion: null,
			priority: "P1",
			language: "zh-CN",
			tier: "CORE",
			ownerId: "user-1",
		},
	],
	memberIds: new Set(["user-1"]),
};

const row = (line: number, cells: Record<string, string>) => ({ line, cells });

describe("prompt CSV import", () => {
	const untouched = {
		prompt_id: FROZEN_ID,
		question: "高低压开关柜供应商怎么比较",
		buyer_role: "采购负责人",
		intent: "选型",
		product_line: "'=开关柜",
		priority: "P1",
		language: "zh-CN",
		tier: "CORE",
		status: "FROZEN",
		test_set_version: "基线 v1",
		owner: "user-1",
	};

	it("counts a reviewed row that came back unchanged, alongside a new row in the same file", () => {
		const { valid, unchanged, errors } = validatePromptCsvRows(
			[row(2, untouched), row(3, { question: "华南成套配电柜厂家有哪些" })],
			context,
		);
		expect(errors).toEqual([]);
		expect(unchanged).toEqual([2]);
		expect(valid.map((entry) => entry.line)).toEqual([3]);
	});

	it.each([
		["question", { question: "高低压开关柜供应商如何比较" }],
		["priority", { priority: "P0" }],
		["owner", { owner: "" }],
		["tier", { tier: "EXTENDED" }],
	])("refuses a reviewed row whose %s was changed", (_field, change) => {
		const { valid, unchanged, errors } = validatePromptCsvRows([row(2, { ...untouched, ...change })], context);
		expect(valid).toEqual([]);
		expect(unchanged).toEqual([]);
		expect(errors.map(({ line, column }) => [line, column])).toEqual([[2, "prompt_id"]]);
	});

	it("reports every problem by line and column instead of stopping at the first", () => {
		const { valid, errors } = validatePromptCsvRows(
			[
				row(2, { question: "华南成套配电柜厂家有哪些", buyer_role: "采购负责人" }),
				row(3, { question: '=HYPERLINK("http://x.test")' }),
				row(4, { question: "华南成套配电柜厂家有哪些", priority: "P9" }),
				row(5, { question: "", buyer_role: "评标专家" }),
			],
			context,
		);
		expect(valid.map((entry) => entry.line)).toEqual([2]);
		expect(errors.map(({ line, column }) => [line, column])).toEqual([
			[3, "question"],
			[4, "question"],
			[4, "priority"],
			[5, "question"],
			[5, "buyer_role"],
		]);
	});

	it("refuses full-width formula prefixes too", () => {
		const { errors } = validatePromptCsvRows([row(2, { question: "开关柜选型", intent: "＋SUM(A1)" })], context);
		expect(errors).toEqual([expect.objectContaining({ line: 2, column: "intent" })]);
	});

	it("will not let a spreadsheet edit a frozen prompt or set its status", () => {
		const { valid, errors } = validatePromptCsvRows(
			[row(2, { prompt_id: FROZEN_ID, question: "高低压开关柜供应商怎么比较", status: "BASELINE" })],
			context,
		);
		expect(valid).toEqual([]);
		expect(errors).toEqual([expect.objectContaining({ column: "prompt_id" })]);
	});

	it("rejects a question already in the library and an owner from outside the organization", () => {
		const { errors } = validatePromptCsvRows(
			[row(2, { question: " 高低压开关柜供应商怎么比较 ", owner: "someone-else" })],
			context,
		);
		expect(errors.map((error) => error.column)).toEqual(["question", "owner"]);
	});
});

describe("prompt CSV export", () => {
	it("neutralizes cells a spreadsheet would run as formulas", () => {
		const csv = toPromptCsv([
			{
				prompt_id: "p1",
				question: "@SUM(1,2)",
				buyer_role: "",
				intent: "-1",
				product_line: "",
				geo_region: "",
				priority: "P1",
				language: "zh-CN",
				tier: "CORE",
				status: "DRAFT",
				test_set_version: "",
				owner: "",
			},
		]);
		expect(csv.startsWith("﻿prompt_id,question")).toBe(true);
		expect(csv).toContain(`p1,"'@SUM(1,2)",,'-1,`);
	});
});
