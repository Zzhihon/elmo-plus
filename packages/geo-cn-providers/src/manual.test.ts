import { describe, expect, it } from "vitest";
import { manualImportErrorCode, normalizeCsvRecord, validateManualRows } from "./manual";

const now = new Date("2026-11-03T00:00:00Z");
const complete = {
	sampledAt: "2026-11-02 08:00",
	platform: "豆包",
	question: "华南高低压开关柜供应商怎么比较",
	responseText: "可以从资质、交付能力和案例比较……",
	evidenceLocation: "https://evidence.example-electric.test/shot-1.png",
	citations: "https://www.example-electric.test/a；https://news.example.test/b",
};

describe("manual evidence import", () => {
	it.each(["geo/org-1/knowledge/abc.pdf", "/geo/org-1/reports/r1/report.pdf", "GEO/org-1/site/s1/raw/a.html"])(
		"refuses %s: a storage path is not a note, and a file has to be uploaded",
		(evidenceLocation) => {
			const { rows, errors } = validateManualRows([{ ...complete, evidenceLocation }], now);
			expect(rows).toEqual([]);
			expect(errors.map((error) => error.field)).toEqual(["evidenceLocation"]);
		},
	);

	it("accepts a complete row and reads a zoneless time as China Standard Time", () => {
		const { rows, errors } = validateManualRows([complete], now);
		expect(errors).toEqual([]);
		expect(rows[0]).toMatchObject({ row: 1, platform: "doubao", status: "VALID" });
		expect(rows[0].sampledAt.toISOString()).toBe("2026-11-02T00:00:00.000Z");
		expect(rows[0].citations).toHaveLength(2);
	});

	it("reports every missing piece of evidence, row by row", () => {
		const { rows, errors } = validateManualRows(
			[complete, { ...complete, sampledAt: "", evidenceLocation: " " }, { platform: "doubao" }],
			now,
		);
		expect(rows).toHaveLength(1);
		expect(errors.filter((error) => error.row === 2).map((error) => error.field)).toEqual([
			"sampledAt",
			"evidenceLocation",
		]);
		expect(errors.filter((error) => error.row === 3).map((error) => error.field)).toEqual([
			"sampledAt",
			"question",
			"responseText",
			"evidenceLocation",
		]);
		expect(manualImportErrorCode(errors)).toBe("EVIDENCE_REQUIRED");
	});

	it("rejects malformed values separately from missing ones", () => {
		const { errors } = validateManualRows(
			[{ ...complete, platform: "某平台", sampledAt: "2027-01-01 00:00", citations: "javascript:alert(1)" }],
			now,
		);
		expect(errors.map((error) => error.field).sort()).toEqual(["citations", "platform", "sampledAt"]);
		expect(manualImportErrorCode(errors)).toBe("VALIDATION_ERROR");
	});

	it("refuses an evidence location with a non-web scheme", () => {
		const { errors } = validateManualRows([{ ...complete, evidenceLocation: "javascript:alert(1)" }], now);
		expect(errors[0]).toMatchObject({ field: "evidenceLocation", code: "VALIDATION_ERROR" });
	});

	it("maps Chinese spreadsheet headers to fields", () => {
		const input = normalizeCsvRecord({
			采样时间: "2026-11-02 08:00",
			平台: "通义千问",
			问题: "q",
			回答原文: "a",
			证据位置: "档案柜 A-3",
		});
		const { rows, errors } = validateManualRows([input], now);
		expect(errors).toEqual([]);
		expect(rows[0]).toMatchObject({ platform: "qwen", evidenceLocation: "档案柜 A-3" });
	});
});
