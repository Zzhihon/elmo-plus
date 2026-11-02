import { describe, expect, it } from "vitest";
import { type GeoBatchFacts, type GeoTaskGateInput, taskGateProblem } from "./task-gates";
import { taskTransition } from "./task-state";

const CREATED = new Date("2026-05-01T00:00:00Z");
const PUBLISHED = new Date("2026-05-10T00:00:00Z");
const NOW = new Date("2026-05-20T00:00:00Z");

const plan = { launchApprovalRef: null, backupPlan: null, rollbackPlan: null };
const siteRevision = {
	kind: "SITE_REVISION" as const,
	riskLevel: "HIGH" as const,
	createdAt: CREATED,
	publishedAt: null,
};

function batch(overrides: Partial<GeoBatchFacts>): GeoBatchFacts {
	return { id: "b", promptSetId: "set-1", createdAt: CREATED, status: "COMPLETED", ...overrides };
}

function verifyInput(overrides: Partial<GeoTaskGateInput> = {}): GeoTaskGateInput {
	return {
		action: "VERIFY",
		task: { kind: "FAQ", riskLevel: "NORMAL", createdAt: CREATED, publishedAt: PUBLISHED, ...plan },
		before: batch({ id: "before", createdAt: new Date("2026-05-05T00:00:00Z") }),
		after: batch({ id: "after", createdAt: new Date("2026-05-15T00:00:00Z") }),
		now: NOW,
		...overrides,
	};
}

describe("high-risk site revision launch plan", () => {
	it("blocks entering 待发布 until approval, backup and rollback are recorded", () => {
		const result = taskGateProblem({ action: "APPROVE_MARKETING", task: { ...siteRevision, ...plan } });
		expect(result?.code).toBe("EVIDENCE_REQUIRED");
		expect(result?.message).toContain("上线审批编号");
		expect(result?.message).toContain("回滚计划");
	});

	it("lets it through once the plan is complete", () => {
		const complete = { launchApprovalRef: "CHG-001", backupPlan: "整站快照", rollbackPlan: "恢复快照" };
		expect(taskGateProblem({ action: "APPROVE_MARKETING", task: { ...siteRevision, ...complete } })).toBeNull();
	});

	it("does not ask ordinary tasks for a launch plan", () => {
		expect(
			taskGateProblem({ action: "APPROVE_MARKETING", task: { ...siteRevision, riskLevel: "NORMAL", ...plan } }),
		).toBeNull();
	});
});

describe("publishing", () => {
	const task = { kind: "FAQ" as const, riskLevel: "NORMAL" as const, createdAt: CREATED, publishedAt: null, ...plan };

	it("needs a real publish time that is neither in the future nor before the task", () => {
		expect(
			taskGateProblem({ action: "PUBLISH", task, payload: { publishedUrl: "https://a.test/x" }, now: NOW })?.code,
		).toBe("EVIDENCE_REQUIRED");
		const future = new Date(NOW.getTime() + 60 * 60 * 1000);
		expect(
			taskGateProblem({
				action: "PUBLISH",
				task,
				payload: { publishedUrl: "https://a.test/x", publishedAt: future },
				now: NOW,
			})?.code,
		).toBe("VALIDATION_ERROR");
		const early = new Date(CREATED.getTime() - 1);
		expect(
			taskGateProblem({
				action: "PUBLISH",
				task,
				payload: { publishedUrl: "https://a.test/x", publishedAt: early },
				now: NOW,
			})?.code,
		).toBe("VALIDATION_ERROR");
	});

	it("rejects a URL that is not http(s)", () => {
		expect(
			taskGateProblem({
				action: "PUBLISH",
				task,
				payload: { publishedUrl: "javascript:alert(1)", publishedAt: PUBLISHED },
				now: NOW,
			})?.code,
		).toBe("VALIDATION_ERROR");
	});

	it("refuses while linked content is not approved", () => {
		const payload = { publishedUrl: "https://a.test/x", publishedAt: PUBLISHED };
		expect(
			taskGateProblem({ action: "PUBLISH", task, payload, contentStates: ["APPROVED", "REJECTED"], now: NOW })?.code,
		).toBe("CONFLICT");
		expect(taskGateProblem({ action: "PUBLISH", task, payload, contentStates: ["APPROVED"], now: NOW })).toBeNull();
	});
});

describe("verifying a retest", () => {
	it("accepts a baseline before publishing and a settled retest after it on the same prompt set", () => {
		expect(taskGateProblem(verifyInput())).toBeNull();
	});

	it("refuses batches from different prompt set versions", () => {
		expect(
			taskGateProblem(verifyInput({ after: batch({ id: "after", promptSetId: "set-2", createdAt: NOW }) }))?.code,
		).toBe("VALIDATION_ERROR");
	});

	it("refuses a retest batch taken before the publish time", () => {
		const early = batch({ id: "after", createdAt: new Date("2026-05-09T00:00:00Z") });
		expect(taskGateProblem(verifyInput({ after: early }))?.message).toContain("发布之后");
	});

	it("refuses a retest that has not finished sampling", () => {
		const running = batch({ id: "after", createdAt: NOW, status: "RUNNING" });
		expect(taskGateProblem(verifyInput({ after: running }))?.code).toBe("CONFLICT");
	});

	it("refuses the same batch on both sides", () => {
		const same = batch({ id: "before", createdAt: new Date("2026-05-05T00:00:00Z") });
		expect(taskGateProblem(verifyInput({ after: same }))?.code).toBe("VALIDATION_ERROR");
	});
});

describe("publishing is not proof of effect", () => {
	it("cannot reach 已验证 from 已发布 without a retest", () => {
		const actor = { kind: "principal" as const, id: "op", roles: ["geo_operator" as const] };
		const facts = { kind: "FAQ" as const, riskLevel: "NORMAL" as const, authorId: "a", ownerId: "op" };
		expect(taskTransition({ task: { ...facts, state: "PUBLISHED" }, action: "VERIFY", actor })).toMatchObject({
			ok: false,
			code: "CONFLICT",
		});
		expect(
			taskTransition({
				task: { ...facts, state: "PENDING_RETEST" },
				action: "VERIFY",
				actor,
				payload: { beforeBatchId: "x" },
			}),
		).toMatchObject({ ok: false, code: "EVIDENCE_REQUIRED" });
	});

	it("keeps reviewers to their own stage", () => {
		const tech = { kind: "principal" as const, id: "t", roles: ["tech_reviewer" as const] };
		const facts = { kind: "FAQ" as const, riskLevel: "HIGH" as const, authorId: "a", ownerId: "o" };
		expect(
			taskTransition({
				task: { ...facts, state: "PENDING_MARKETING_REVIEW" },
				action: "APPROVE_MARKETING",
				actor: tech,
			}),
		).toMatchObject({ ok: false, code: "FORBIDDEN" });
		expect(
			taskTransition({
				task: { ...facts, state: "PENDING_TECH_REVIEW" },
				action: "REJECT",
				actor: tech,
				payload: { comment: "参数与手册不一致" },
			}),
		).toEqual({ ok: true, to: "REJECTED" });
	});
});
