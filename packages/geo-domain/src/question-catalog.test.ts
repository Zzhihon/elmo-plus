import { describe, expect, it } from "vitest";
import { GEO_DEFAULT_BUYER_ROLES } from "./enums";
import { normalizePromptQuestion } from "./prompt-csv";
import {
	catalogAdoptionTransition,
	catalogSelectionProblem,
	GEO_CATALOG_SELECTION_MAX,
	GEO_CATALOG_SELECTION_MIN,
	GEO_DISCOVERY_QUESTIONS,
	GEO_QUESTION_CATALOG,
} from "./question-catalog";
import type { GeoTransitionActor } from "./transition";

const all = [...GEO_QUESTION_CATALOG, ...GEO_DISCOVERY_QUESTIONS];

describe("question catalog", () => {
	it("never asks the same question twice, so picking one can never match two prompts", () => {
		expect(new Set(all.map((item) => item.code)).size).toBe(all.length);
		expect(new Set(all.map((item) => normalizePromptQuestion(item.question))).size).toBe(all.length);
	});

	it("offers a default selection that can be saved as is and reaches every buyer role", () => {
		const recommended = GEO_QUESTION_CATALOG.filter((item) => item.recommended);
		expect(catalogSelectionProblem(recommended.length)).toBeNull();
		for (const role of GEO_DEFAULT_BUYER_ROLES) {
			expect(recommended.some((item) => item.buyerRoleCode === role.code)).toBe(true);
		}
	});

	it("keeps discovery questions out of routine monitoring", () => {
		expect(GEO_DISCOVERY_QUESTIONS.every((item) => item.tier === "EXTENDED")).toBe(true);
		expect(GEO_QUESTION_CATALOG.every((item) => item.tier === "CORE")).toBe(true);
	});

	it("only accepts a selection between the minimum and maximum", () => {
		expect(catalogSelectionProblem(GEO_CATALOG_SELECTION_MIN - 1)).not.toBeNull();
		expect(catalogSelectionProblem(GEO_CATALOG_SELECTION_MAX + 1)).not.toBeNull();
		expect(catalogSelectionProblem(GEO_CATALOG_SELECTION_MAX)).toBeNull();
	});
});

describe("adopting a catalog question", () => {
	const marketing: GeoTransitionActor = { kind: "principal", id: "u1", roles: ["marketing_reviewer"] };

	it("counts as the business review for a draft or a question waiting for review", () => {
		expect(catalogAdoptionTransition("DRAFT", marketing)).toEqual({ ok: true, to: "BASELINE" });
		expect(catalogAdoptionTransition("IN_REVIEW", marketing)).toEqual({ ok: true, to: "BASELINE" });
	});

	it("does not overturn a reviewer's rejection", () => {
		expect(catalogAdoptionTransition("REJECTED", marketing)).toMatchObject({ ok: false, code: "CONFLICT" });
	});

	it("is not open to a viewer", () => {
		expect(catalogAdoptionTransition("DRAFT", { kind: "principal", id: "u2", roles: ["viewer"] })).toMatchObject({
			ok: false,
			code: "FORBIDDEN",
		});
	});
});
