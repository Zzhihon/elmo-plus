import { describe, expect, it } from "vitest";
import { contentTransition } from "./content-state";
import { type GeoDraftFact, validateDraft } from "./draft-validation";

const facts: GeoDraftFact[] = [
	{
		ref: "F1",
		assertionId: "a1",
		entityTitle: "KYN28A-12 高压开关柜",
		claimText: "额定电压 12kV，额定电流 630A",
		normalizedValue: "额定电压 12kV，额定电流 630A",
		riskLevel: "HIGH",
	},
	{
		ref: "F2",
		assertionId: "a2",
		entityTitle: "示例电气",
		claimText: "产品执行 GB/T 11022-2020 标准，通过 ISO9001质量管理体系认证",
		normalizedValue: null,
		riskLevel: "HIGH",
	},
	{
		ref: "F3",
		assertionId: "a3",
		entityTitle: "示例电气",
		claimText: "服务网点覆盖 12 个城市",
		normalizedValue: null,
		riskLevel: "NORMAL",
	},
];

describe("draft fact check", () => {
	it("accepts numbers, models and standards found in the facts the sentence cites", () => {
		const result = validateDraft(
			"KYN28A-12 的额定电压为 12kV，额定电流 630A [F1]。产品执行 GB/T 11022-2020。[F2]",
			facts,
		);
		expect(result.blocking).toBe(false);
		expect(result.checks.every((check) => check.status === "SUPPORTED")).toBe(true);
		expect(result.citedRefs).toEqual(["F1", "F2"]);
	});

	it("blocks a technical value that contradicts the cited fact", () => {
		const result = validateDraft("该柜型额定电压 24kV [F1]。", facts);
		expect(result.blocking).toBe(true);
		expect(result.checks).toContainEqual(expect.objectContaining({ token: "24kV", status: "MISMATCH", risk: "HIGH" }));
	});

	it("blocks a key number no fact supports and a model the facts do not name", () => {
		const result = validateDraft("产品额定短时耐受电流 31.5kA。另有 XGN15-12 可选 [F1]。", facts);
		expect(result.blocking).toBe(true);
		const unsupported = result.checks.filter((check) => check.status !== "SUPPORTED").map((check) => check.token);
		expect(unsupported).toEqual(expect.arrayContaining(["31.5kA", "XGN15-12"]));
	});

	it("marks an ordinary unsourced claim as pending instead of blocking it", () => {
		const result = validateDraft("我们有 3 个专属服务团队。", facts);
		expect(result.blocking).toBe(false);
		expect(result.pendingCount).toBe(1);
		expect(result.checks[0]).toMatchObject({ token: "3个", status: "UNSUPPORTED", risk: "NORMAL" });
	});

	it("flags a supported value whose sentence forgot the citation", () => {
		const result = validateDraft("服务网点覆盖 12 个城市。", facts);
		expect(result.checks[0]).toMatchObject({ status: "UNCITED", supportingRefs: ["F3"] });
		expect(result.blocking).toBe(false);
	});

	it("refuses a citation to a fact that was never supplied", () => {
		const result = validateDraft("质保期两年 [F9]。", facts);
		expect(result.unknownRefs).toEqual(["F9"]);
		expect(result.blocking).toBe(true);
	});
});

describe("draft review flow", () => {
	const reviewer = (id: string, role: "tech_reviewer" | "marketing_reviewer") =>
		({ kind: "principal", id, roles: [role] }) as const;

	it("goes through technical then marketing review", () => {
		const tech = contentTransition({
			item: { state: "PENDING_TECH_REVIEW", authorIds: ["writer"] },
			action: "APPROVE_TECH",
			actor: reviewer("engineer", "tech_reviewer"),
		});
		expect(tech).toEqual({ ok: true, to: "PENDING_MARKETING_REVIEW" });
		const skipped = contentTransition({
			item: { state: "PENDING_TECH_REVIEW", authorIds: ["writer"] },
			action: "APPROVE_MARKETING",
			actor: reviewer("marketer", "marketing_reviewer"),
		});
		expect(skipped).toMatchObject({ ok: false, code: "CONFLICT" });
	});

	it("does not let an author review a draft they wrote", () => {
		const result = contentTransition({
			item: { state: "PENDING_TECH_REVIEW", authorIds: ["writer", "engineer"] },
			action: "APPROVE_TECH",
			actor: reviewer("engineer", "tech_reviewer"),
		});
		expect(result).toMatchObject({ ok: false, code: "FORBIDDEN" });
	});

	it("needs a comment to send a draft back", () => {
		const item = { state: "PENDING_MARKETING_REVIEW" as const, authorIds: ["writer"] };
		const actor = reviewer("marketer", "marketing_reviewer");
		expect(contentTransition({ item, action: "REJECT", actor })).toMatchObject({ ok: false });
		expect(contentTransition({ item, action: "REJECT", actor, comment: "宣传口径过度" })).toEqual({
			ok: true,
			to: "REJECTED",
		});
	});
});
