import type { GeoRiskLevel, GeoTaskKind, GeoTaskState } from "./enums";
import type { GeoPermission } from "./permissions";
import { actorHolds, fail, type GeoTransitionActor, type GeoTransitionResult, hasText } from "./transition";

export const GEO_TASK_ACTIONS = [
	"TRIAGE",
	"ASSIGN",
	"SUBMIT_FOR_REVIEW",
	"APPROVE_TECH",
	"APPROVE_MARKETING",
	"REJECT",
	"REWORK",
	"PUBLISH",
	"REQUEST_RETEST",
	"VERIFY",
	"REOPEN",
	"PAUSE",
	"RESUME",
	"CANCEL",
] as const;
export type GeoTaskAction = (typeof GEO_TASK_ACTIONS)[number];

const TERMINAL: readonly GeoTaskState[] = ["VERIFIED", "CANCELLED"];
const PAUSABLE: readonly GeoTaskState[] = [
	"PENDING_ANALYSIS",
	"PENDING_ASSIGNMENT",
	"IN_PROGRESS",
	"PENDING_TECH_REVIEW",
	"PENDING_MARKETING_REVIEW",
	"PENDING_PUBLISH",
	"PUBLISHED",
	"PENDING_RETEST",
	"REJECTED",
];

const EDGES: Partial<Record<GeoTaskAction, Partial<Record<GeoTaskState, GeoTaskState>>>> = {
	TRIAGE: { PENDING_ANALYSIS: "PENDING_ASSIGNMENT" },
	ASSIGN: { PENDING_ASSIGNMENT: "IN_PROGRESS" },
	SUBMIT_FOR_REVIEW: { IN_PROGRESS: "PENDING_TECH_REVIEW" },
	APPROVE_TECH: { PENDING_TECH_REVIEW: "PENDING_MARKETING_REVIEW" },
	APPROVE_MARKETING: { PENDING_MARKETING_REVIEW: "PENDING_PUBLISH" },
	REJECT: {
		PENDING_TECH_REVIEW: "REJECTED",
		PENDING_MARKETING_REVIEW: "REJECTED",
		PENDING_PUBLISH: "REJECTED",
	},
	REWORK: { REJECTED: "IN_PROGRESS" },
	PUBLISH: { PENDING_PUBLISH: "PUBLISHED" },
	REQUEST_RETEST: { PUBLISHED: "PENDING_RETEST" },
	VERIFY: { PENDING_RETEST: "VERIFIED" },
	REOPEN: { PENDING_RETEST: "IN_PROGRESS" },
};

const ACTION_PERMISSION: Record<GeoTaskAction, GeoPermission> = {
	TRIAGE: "task.transition",
	ASSIGN: "task.transition",
	SUBMIT_FOR_REVIEW: "task.transition",
	APPROVE_TECH: "task.review_tech",
	APPROVE_MARKETING: "task.review_marketing",
	REJECT: "task.transition",
	REWORK: "task.transition",
	PUBLISH: "task.publish",
	REQUEST_RETEST: "task.transition",
	VERIFY: "task.transition",
	REOPEN: "task.transition",
	PAUSE: "task.transition",
	RESUME: "task.transition",
	CANCEL: "task.transition",
};

const REJECT_PERMISSION: Partial<Record<GeoTaskState, GeoPermission>> = {
	PENDING_TECH_REVIEW: "task.review_tech",
	PENDING_MARKETING_REVIEW: "task.review_marketing",
	PENDING_PUBLISH: "task.review_marketing",
};

export interface GeoTaskFacts {
	state: GeoTaskState;
	kind: GeoTaskKind;
	riskLevel: GeoRiskLevel;
	authorId: string | null;
	ownerId: string | null;
	/** Everyone the task's history made responsible; a handover does not turn them into reviewers. */
	pastOwnerIds?: readonly string[];
	/** Who gave the technical approval this round, who then may not also give the marketing one. */
	techApproverId?: string | null;
	/** The state a paused task returns to. */
	pausedFrom?: GeoTaskState | null;
}

export interface GeoTaskTransitionPayload {
	comment?: string | null;
	ownerId?: string | null;
	publishedUrl?: string | null;
	proof?: unknown;
	rollbackPlan?: string | null;
	beforeBatchId?: string | null;
	afterBatchId?: string | null;
}

export interface GeoTaskTransitionInput {
	task: GeoTaskFacts;
	action: GeoTaskAction;
	actor: GeoTransitionActor;
	payload?: GeoTaskTransitionPayload;
}

const APPROVALS: readonly GeoTaskAction[] = ["APPROVE_TECH", "APPROVE_MARKETING"];

function target(task: GeoTaskFacts, action: GeoTaskAction): GeoTaskState | undefined {
	if (action === "PAUSE") return PAUSABLE.includes(task.state) ? "PAUSED" : undefined;
	if (action === "RESUME") return task.state === "PAUSED" ? (task.pausedFrom ?? undefined) : undefined;
	if (action === "CANCEL") return TERMINAL.includes(task.state) ? undefined : "CANCELLED";
	return EDGES[action]?.[task.state];
}

function isAuthorOrOwner(task: GeoTaskFacts, actor: GeoTransitionActor): boolean {
	if (actor.kind !== "principal") return false;
	return actor.id === task.authorId || actor.id === task.ownerId || Boolean(task.pastOwnerIds?.includes(actor.id));
}

function approvalProblem(task: GeoTaskFacts, action: GeoTaskAction, actor: GeoTransitionActor) {
	if (!APPROVALS.includes(action) || task.riskLevel !== "HIGH") return null;
	if (isAuthorOrOwner(task, actor)) return fail<GeoTaskState>("FORBIDDEN", "高风险内容不能由作者或责任人本人审核");
	if (action === "APPROVE_MARKETING" && actor.kind === "principal" && actor.id === task.techApproverId) {
		return fail<GeoTaskState>("FORBIDDEN", "高风险内容的技术审核和市场审核必须由不同的人完成");
	}
	return null;
}

function publishProblem(
	task: GeoTaskFacts,
	payload: GeoTaskTransitionPayload,
): GeoTransitionResult<GeoTaskState> | null {
	if (!hasText(payload.publishedUrl)) return fail("EVIDENCE_REQUIRED", "发布必须登记实际发布 URL");
	if (payload.proof === undefined || payload.proof === null) {
		return fail("EVIDENCE_REQUIRED", "发布必须录入可验证凭证");
	}
	if (task.kind === "SITE_REVISION" && task.riskLevel === "HIGH" && !hasText(payload.rollbackPlan)) {
		return fail("EVIDENCE_REQUIRED", "高风险官网改造必须提供上线审批、备份与回滚计划");
	}
	return null;
}

function payloadProblem(input: GeoTaskTransitionInput): GeoTransitionResult<GeoTaskState> | null {
	const { action, task, payload = {} } = input;
	switch (action) {
		case "ASSIGN":
			return hasText(payload.ownerId ?? task.ownerId) ? null : fail("VALIDATION_ERROR", "指派工单必须指定责任人");
		case "REJECT":
		case "CANCEL":
		case "PAUSE":
		case "REOPEN":
			return hasText(payload.comment) ? null : fail("VALIDATION_ERROR", "此操作必须填写意见");
		case "PUBLISH":
			return publishProblem(task, payload);
		case "VERIFY":
			return hasText(payload.beforeBatchId) && hasText(payload.afterBatchId)
				? null
				: fail("EVIDENCE_REQUIRED", "验证必须关联复测前后的采样批次");
		default:
			return null;
	}
}

export function taskTransition(input: GeoTaskTransitionInput): GeoTransitionResult<GeoTaskState> {
	const { task, action, actor } = input;
	const to = target(task, action);
	if (!to) return fail("CONFLICT", `工单当前状态 ${task.state} 不允许执行 ${action}`);

	const permission =
		action === "REJECT" ? (REJECT_PERMISSION[task.state] ?? ACTION_PERMISSION.REJECT) : ACTION_PERMISSION[action];
	if (!actorHolds(actor, permission)) return fail("FORBIDDEN", "当前账号没有执行此工单操作的权限");

	return approvalProblem(task, action, actor) ?? payloadProblem(input) ?? { ok: true, to };
}
