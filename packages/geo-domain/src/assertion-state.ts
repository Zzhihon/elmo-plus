import type { GeoAssertionStatus, GeoPublicationScope, GeoRiskLevel } from "./enums";
import { fail, type GeoTransitionActor, type GeoTransitionResult, hasText, actorHolds } from "./transition";

export const GEO_ASSERTION_ACTIONS = [
	"PARSE",
	"SUBMIT_FOR_REVIEW",
	"APPROVE",
	"REJECT",
	"REQUEST_EVIDENCE",
	"INVALIDATE",
	"RESUBMIT",
	"SUPERSEDE",
	"MARK_SOURCE_UNAVAILABLE",
] as const;
export type GeoAssertionAction = (typeof GEO_ASSERTION_ACTIONS)[number];

const EDGES: Record<GeoAssertionAction, Partial<Record<GeoAssertionStatus, GeoAssertionStatus>>> = {
	PARSE: { DISCOVERED: "PARSED" },
	SUBMIT_FOR_REVIEW: { PARSED: "PENDING_REVIEW" },
	APPROVE: { PENDING_REVIEW: "APPROVED" },
	REJECT: { PENDING_REVIEW: "REJECTED" },
	REQUEST_EVIDENCE: { PENDING_REVIEW: "NEEDS_EVIDENCE" },
	INVALIDATE: { APPROVED: "REJECTED", SOURCE_UNAVAILABLE: "REJECTED" },
	RESUBMIT: { NEEDS_EVIDENCE: "PENDING_REVIEW", REJECTED: "PENDING_REVIEW", SOURCE_UNAVAILABLE: "PENDING_REVIEW" },
	SUPERSEDE: { APPROVED: "SUPERSEDED", SOURCE_UNAVAILABLE: "SUPERSEDED" },
	MARK_SOURCE_UNAVAILABLE: { APPROVED: "SOURCE_UNAVAILABLE", PENDING_REVIEW: "SOURCE_UNAVAILABLE" },
};

const SYSTEM_ACTIONS: readonly GeoAssertionAction[] = [
	"PARSE",
	"SUBMIT_FOR_REVIEW",
	"SUPERSEDE",
	"MARK_SOURCE_UNAVAILABLE",
];
const REVIEW_ACTIONS: readonly GeoAssertionAction[] = ["APPROVE", "REJECT", "REQUEST_EVIDENCE", "INVALIDATE"];

export interface GeoAssertionFacts {
	status: GeoAssertionStatus;
	riskLevel: GeoRiskLevel;
	/** The person who entered it by hand; null when it was extracted by a crawl. */
	authorId: string | null;
	validUntil?: Date | null;
}

export interface GeoAssertionReviewPayload {
	basis?: string | null;
	publicationScope?: GeoPublicationScope | null;
	sourceRef?: unknown;
	/** A customer original is on file. A web page alone never settles a high-risk fact. */
	hasOriginalDocument?: boolean;
	hasOpenConflict?: boolean;
	supersededById?: string | null;
}

export interface GeoAssertionTransitionInput {
	assertion: GeoAssertionFacts;
	action: GeoAssertionAction;
	actor: GeoTransitionActor;
	payload?: GeoAssertionReviewPayload;
	now?: Date;
}

function approvalProblem(input: GeoAssertionTransitionInput): GeoTransitionResult<GeoAssertionStatus> | null {
	const { assertion, payload = {}, now = new Date() } = input;
	if (!payload.publicationScope) return fail("VALIDATION_ERROR", "审核通过必须指定可公开范围");
	if (payload.sourceRef === undefined || payload.sourceRef === null) {
		return fail("EVIDENCE_REQUIRED", "审核通过必须绑定来源页面版本或资料原件");
	}
	if (payload.hasOpenConflict) return fail("CONFLICT", "存在未解决的冲突，不能审核通过");
	if (assertion.validUntil && assertion.validUntil.getTime() <= now.getTime()) {
		return fail("EVIDENCE_REQUIRED", "资料已过期，不能审核通过");
	}
	if (assertion.riskLevel === "HIGH" && !payload.hasOriginalDocument) {
		return fail("EVIDENCE_REQUIRED", "高风险事实必须结合客户原件校验");
	}
	return null;
}

function payloadProblem(input: GeoAssertionTransitionInput): GeoTransitionResult<GeoAssertionStatus> | null {
	const { action, payload = {} } = input;
	if (REVIEW_ACTIONS.includes(action) && !hasText(payload.basis)) {
		return fail("VALIDATION_ERROR", "审核必须填写依据");
	}
	if (action === "APPROVE") return approvalProblem(input);
	if (action === "SUPERSEDE" && !hasText(payload.supersededById)) {
		return fail("VALIDATION_ERROR", "替代操作必须指向新的断言");
	}
	return null;
}

export function assertionTransition(input: GeoAssertionTransitionInput): GeoTransitionResult<GeoAssertionStatus> {
	const { assertion, action, actor } = input;
	const to = EDGES[action][assertion.status];
	if (!to) return fail("CONFLICT", `断言当前状态 ${assertion.status} 不允许执行 ${action}`);

	const systemDriven = SYSTEM_ACTIONS.includes(action);
	const allowed = systemDriven
		? actor.kind === "system" || actorHolds(actor, "knowledge.review")
		: actorHolds(actor, action === "RESUBMIT" ? "knowledge.write" : "knowledge.review");
	if (!allowed) return fail("FORBIDDEN", "当前账号没有审核此断言的权限");

	if (
		action === "APPROVE" &&
		assertion.riskLevel === "HIGH" &&
		actor.kind === "principal" &&
		actor.id === assertion.authorId
	) {
		return fail("FORBIDDEN", "高风险事实不能由录入人本人审核");
	}

	return payloadProblem(input) ?? { ok: true, to };
}
