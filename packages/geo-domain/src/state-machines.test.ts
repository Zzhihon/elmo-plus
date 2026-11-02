import { describe, expect, it } from "vitest";
import { assertionTransition, type GeoAssertionFacts } from "./assertion-state";
import { GEO_TASK_STATES, type GeoTaskState } from "./enums";
import type { GeoRole } from "./permissions";
import { isPromptEditable, promptSetFreezeTransition, promptTransition } from "./prompt-state";
import { type GeoTaskAction, type GeoTaskFacts, taskTransition } from "./task-state";
import type { GeoTransitionActor } from "./transition";

const actor = (id: string, ...roles: GeoRole[]): GeoTransitionActor => ({ kind: "principal", id, roles });
const operator = actor("op", "geo_operator");
const tech = actor("tech", "tech_reviewer");
const marketing = actor("mkt", "marketing_reviewer");
const admin = actor("admin", "platform_admin");

const task = (state: GeoTaskState, extra: Partial<GeoTaskFacts> = {}): GeoTaskFacts => ({
	state,
	kind: "FAQ",
	riskLevel: "NORMAL",
	authorId: "op",
	ownerId: "op",
	...extra,
});

describe("taskTransition", () => {
	it("walks the whole path from analysis to verified", () => {
		const steps: [GeoTaskState, GeoTaskAction, GeoTransitionActor, GeoTaskState, object?][] = [
			["PENDING_ANALYSIS", "TRIAGE", operator, "PENDING_ASSIGNMENT"],
			["PENDING_ASSIGNMENT", "ASSIGN", operator, "IN_PROGRESS", { ownerId: "op" }],
			["IN_PROGRESS", "SUBMIT_FOR_REVIEW", operator, "PENDING_TECH_REVIEW"],
			["PENDING_TECH_REVIEW", "APPROVE_TECH", tech, "PENDING_MARKETING_REVIEW"],
			["PENDING_MARKETING_REVIEW", "APPROVE_MARKETING", marketing, "PENDING_PUBLISH"],
			["PENDING_PUBLISH", "PUBLISH", operator, "PUBLISHED", { publishedUrl: "https://www.example-electric.test/a", proof: { note: "截图" } }],
			["PUBLISHED", "REQUEST_RETEST", operator, "PENDING_RETEST"],
			["PENDING_RETEST", "VERIFY", operator, "VERIFIED", { beforeBatchId: "b1", afterBatchId: "b2" }],
		];
		for (const [state, action, who, to, payload] of steps) {
			expect(taskTransition({ task: task(state), action, actor: who, payload })).toEqual({ ok: true, to });
		}
	});

	it("does not let a publish skip the verifiable proof", () => {
		const result = taskTransition({
			task: task("PENDING_PUBLISH"),
			action: "PUBLISH",
			actor: operator,
			payload: { publishedUrl: "https://www.example-electric.test/a" },
		});
		expect(result).toMatchObject({ ok: false, code: "EVIDENCE_REQUIRED" });
	});

	it("never treats a published task as verified without a retest", () => {
		const skip = taskTransition({
			task: task("PUBLISHED"),
			action: "VERIFY",
			actor: operator,
			payload: { beforeBatchId: "b1", afterBatchId: "b2" },
		});
		expect(skip).toMatchObject({ ok: false, code: "CONFLICT" });

		const noBatches = taskTransition({ task: task("PENDING_RETEST"), action: "VERIFY", actor: operator });
		expect(noBatches).toMatchObject({ ok: false, code: "EVIDENCE_REQUIRED" });
	});

	it("requires a comment to reject and sends the task back through rework", () => {
		expect(taskTransition({ task: task("PENDING_TECH_REVIEW"), action: "REJECT", actor: tech })).toMatchObject({
			ok: false,
			code: "VALIDATION_ERROR",
		});
		expect(
			taskTransition({
				task: task("PENDING_TECH_REVIEW"),
				action: "REJECT",
				actor: tech,
				payload: { comment: "参数与手册不符" },
			}),
		).toEqual({ ok: true, to: "REJECTED" });
		expect(taskTransition({ task: task("REJECTED"), action: "REWORK", actor: operator })).toEqual({
			ok: true,
			to: "IN_PROGRESS",
		});
	});

	it("stops a reviewer of one discipline rejecting at the other's gate", () => {
		const result = taskTransition({
			task: task("PENDING_MARKETING_REVIEW"),
			action: "REJECT",
			actor: tech,
			payload: { comment: "不符合" },
		});
		expect(result).toMatchObject({ ok: false, code: "FORBIDDEN" });
	});

	it("refuses a self-approval of high-risk work even when the author holds the review role", () => {
		const authorWhoReviews = actor("op", "geo_operator", "tech_reviewer");
		const highRisk = task("PENDING_TECH_REVIEW", { riskLevel: "HIGH" });
		expect(taskTransition({ task: highRisk, action: "APPROVE_TECH", actor: authorWhoReviews })).toMatchObject({
			ok: false,
			code: "FORBIDDEN",
		});
		expect(taskTransition({ task: highRisk, action: "APPROVE_TECH", actor: tech })).toEqual({
			ok: true,
			to: "PENDING_MARKETING_REVIEW",
		});
	});

	it("gives an administrator no route around a review", () => {
		const result = taskTransition({ task: task("PENDING_TECH_REVIEW"), action: "APPROVE_TECH", actor: admin });
		expect(result).toMatchObject({ ok: false, code: "FORBIDDEN" });
	});

	it("asks a high-risk site change for a rollback plan before publishing", () => {
		const site = task("PENDING_PUBLISH", { kind: "SITE_REVISION", riskLevel: "HIGH" });
		const payload = { publishedUrl: "https://www.example-electric.test/a", proof: { note: "截图" } };
		expect(taskTransition({ task: site, action: "PUBLISH", actor: operator, payload })).toMatchObject({
			ok: false,
			code: "EVIDENCE_REQUIRED",
		});
		expect(
			taskTransition({
				task: site,
				action: "PUBLISH",
				actor: operator,
				payload: { ...payload, rollbackPlan: "回滚到上一版本" },
			}),
		).toEqual({ ok: true, to: "PUBLISHED" });
	});

	it("resumes a paused task where it stopped", () => {
		expect(
			taskTransition({
				task: task("PENDING_TECH_REVIEW"),
				action: "PAUSE",
				actor: operator,
				payload: { comment: "等待客户资料" },
			}),
		).toEqual({ ok: true, to: "PAUSED" });
		expect(
			taskTransition({ task: task("PAUSED", { pausedFrom: "PENDING_TECH_REVIEW" }), action: "RESUME", actor: operator }),
		).toEqual({ ok: true, to: "PENDING_TECH_REVIEW" });
		expect(taskTransition({ task: task("PAUSED"), action: "RESUME", actor: operator })).toMatchObject({
			ok: false,
			code: "CONFLICT",
		});
	});

	it("lets anything but a finished task be cancelled, with a reason", () => {
		const payload = { comment: "需求取消" };
		for (const state of GEO_TASK_STATES) {
			const result = taskTransition({ task: task(state), action: "CANCEL", actor: operator, payload });
			expect(result.ok, state).toBe(state !== "VERIFIED" && state !== "CANCELLED");
		}
		expect(taskTransition({ task: task("IN_PROGRESS"), action: "CANCEL", actor: operator })).toMatchObject({
			ok: false,
			code: "VALIDATION_ERROR",
		});
	});

	it("refuses a worker driving a task", () => {
		expect(taskTransition({ task: task("PENDING_ANALYSIS"), action: "TRIAGE", actor: { kind: "system" } })).toMatchObject(
			{ ok: false, code: "FORBIDDEN" },
		);
	});
});

describe("assertionTransition", () => {
	const reviewer = actor("rev", "knowledge_reviewer");
	const assertion = (extra: Partial<GeoAssertionFacts> = {}): GeoAssertionFacts => ({
		status: "PENDING_REVIEW",
		riskLevel: "NORMAL",
		authorId: null,
		...extra,
	});
	const approval = { basis: "核对官网页面", publicationScope: "PUBLIC" as const, sourceRef: { pageVersionId: "v1" } };

	it("moves a crawled claim to review only through the worker's steps", () => {
		const system = { kind: "system" } as const;
		expect(assertionTransition({ assertion: assertion({ status: "DISCOVERED" }), action: "PARSE", actor: system })).toEqual({
			ok: true,
			to: "PARSED",
		});
		expect(
			assertionTransition({ assertion: assertion({ status: "PARSED" }), action: "SUBMIT_FOR_REVIEW", actor: system }),
		).toEqual({ ok: true, to: "PENDING_REVIEW" });
		expect(assertionTransition({ assertion: assertion(), action: "APPROVE", actor: system, payload: approval })).toMatchObject(
			{ ok: false, code: "FORBIDDEN" },
		);
	});

	it("binds an approval to a basis, a scope and a source", () => {
		const approve = (payload: object) => assertionTransition({ assertion: assertion(), action: "APPROVE", actor: reviewer, payload });
		expect(approve(approval)).toEqual({ ok: true, to: "APPROVED" });
		expect(approve({ ...approval, basis: " " })).toMatchObject({ ok: false, code: "VALIDATION_ERROR" });
		expect(approve({ ...approval, publicationScope: null })).toMatchObject({ ok: false, code: "VALIDATION_ERROR" });
		expect(approve({ ...approval, sourceRef: null })).toMatchObject({ ok: false, code: "EVIDENCE_REQUIRED" });
	});

	it("does not settle a high-risk fact on a web page alone", () => {
		const highRisk = assertion({ riskLevel: "HIGH" });
		expect(assertionTransition({ assertion: highRisk, action: "APPROVE", actor: reviewer, payload: approval })).toMatchObject({
			ok: false,
			code: "EVIDENCE_REQUIRED",
		});
		expect(
			assertionTransition({
				assertion: highRisk,
				action: "APPROVE",
				actor: reviewer,
				payload: { ...approval, hasOriginalDocument: true },
			}),
		).toEqual({ ok: true, to: "APPROVED" });
	});

	it("keeps a conflicting or expired claim out of the approved set", () => {
		expect(
			assertionTransition({
				assertion: assertion(),
				action: "APPROVE",
				actor: reviewer,
				payload: { ...approval, hasOpenConflict: true },
			}),
		).toMatchObject({ ok: false, code: "CONFLICT" });
		expect(
			assertionTransition({
				assertion: assertion({ validUntil: new Date("2026-01-01T00:00:00Z") }),
				action: "APPROVE",
				actor: reviewer,
				payload: approval,
				now: new Date("2026-06-01T00:00:00Z"),
			}),
		).toMatchObject({ ok: false, code: "EVIDENCE_REQUIRED" });
	});

	it("refuses the person who entered a high-risk claim as its reviewer", () => {
		const result = assertionTransition({
			assertion: assertion({ riskLevel: "HIGH", authorId: "rev" }),
			action: "APPROVE",
			actor: reviewer,
			payload: { ...approval, hasOriginalDocument: true },
		});
		expect(result).toMatchObject({ ok: false, code: "FORBIDDEN" });
	});

	it("sends a claim whose source vanished back for review instead of deleting it", () => {
		expect(
			assertionTransition({
				assertion: assertion({ status: "APPROVED" }),
				action: "MARK_SOURCE_UNAVAILABLE",
				actor: { kind: "system" },
			}),
		).toEqual({ ok: true, to: "SOURCE_UNAVAILABLE" });
		expect(
			assertionTransition({ assertion: assertion({ status: "SOURCE_UNAVAILABLE" }), action: "RESUBMIT", actor: reviewer }),
		).toEqual({ ok: true, to: "PENDING_REVIEW" });
	});

	it("only supersedes an approved claim with a named successor", () => {
		const approved = assertion({ status: "APPROVED" });
		expect(assertionTransition({ assertion: approved, action: "SUPERSEDE", actor: { kind: "system" } })).toMatchObject({
			ok: false,
			code: "VALIDATION_ERROR",
		});
		expect(
			assertionTransition({
				assertion: approved,
				action: "SUPERSEDE",
				actor: { kind: "system" },
				payload: { supersededById: "a2" },
			}),
		).toEqual({ ok: true, to: "SUPERSEDED" });
	});

	it("keeps operators from approving", () => {
		expect(assertionTransition({ assertion: assertion(), action: "APPROVE", actor: operator, payload: approval })).toMatchObject({
			ok: false,
			code: "FORBIDDEN",
		});
	});
});

describe("promptTransition", () => {
	it("walks draft, business review, baseline and frozen", () => {
		expect(promptTransition({ status: "DRAFT", action: "SUBMIT", actor: operator })).toEqual({ ok: true, to: "IN_REVIEW" });
		expect(promptTransition({ status: "IN_REVIEW", action: "APPROVE", actor: marketing })).toEqual({ ok: true, to: "BASELINE" });
		expect(promptTransition({ status: "BASELINE", action: "FREEZE", actor: operator })).toEqual({ ok: true, to: "FROZEN" });
	});

	it("skips no stage", () => {
		expect(promptTransition({ status: "DRAFT", action: "FREEZE", actor: operator })).toMatchObject({ ok: false, code: "CONFLICT" });
		expect(promptTransition({ status: "DRAFT", action: "APPROVE", actor: marketing })).toMatchObject({ ok: false, code: "CONFLICT" });
	});

	it("reserves the review for a reviewer and needs a reason to reject", () => {
		expect(promptTransition({ status: "IN_REVIEW", action: "APPROVE", actor: operator })).toMatchObject({
			ok: false,
			code: "FORBIDDEN",
		});
		expect(promptTransition({ status: "IN_REVIEW", action: "REJECT", actor: marketing })).toMatchObject({
			ok: false,
			code: "VALIDATION_ERROR",
		});
	});

	it("edits a frozen question only by starting a new draft revision", () => {
		expect(isPromptEditable("FROZEN")).toBe(false);
		expect(promptTransition({ status: "FROZEN", action: "REVISE", actor: operator })).toEqual({ ok: true, to: "DRAFT" });
		expect(isPromptEditable("DRAFT")).toBe(true);
	});
});

describe("promptSetFreezeTransition", () => {
	it("freezes a populated draft once", () => {
		expect(promptSetFreezeTransition("DRAFT", operator, 20)).toEqual({ ok: true, to: "FROZEN" });
		expect(promptSetFreezeTransition("FROZEN", operator, 20)).toMatchObject({ ok: false, code: "CONFLICT" });
		expect(promptSetFreezeTransition("DRAFT", operator, 0)).toMatchObject({ ok: false, code: "VALIDATION_ERROR" });
	});
});
