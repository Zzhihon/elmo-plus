import type { GeoContentAction, GeoContentApprovalState } from "./enums";
import type { GeoPermission } from "./permissions";
import { actorHolds, fail, type GeoTransitionActor, type GeoTransitionResult, hasText } from "./transition";

const EDGES: Record<GeoContentAction, Partial<Record<GeoContentApprovalState, GeoContentApprovalState>>> = {
	SUBMIT: { DRAFT: "PENDING_TECH_REVIEW" },
	APPROVE_TECH: { PENDING_TECH_REVIEW: "PENDING_MARKETING_REVIEW" },
	APPROVE_MARKETING: { PENDING_MARKETING_REVIEW: "APPROVED" },
	REJECT: { PENDING_TECH_REVIEW: "REJECTED", PENDING_MARKETING_REVIEW: "REJECTED" },
	REVISE: { DRAFT: "DRAFT", REJECTED: "DRAFT", APPROVED: "DRAFT" },
	PUBLISH: { APPROVED: "PUBLISHED", PUBLISHED: "PUBLISHED" },
};

const REVIEW_ACTIONS: readonly GeoContentAction[] = ["APPROVE_TECH", "APPROVE_MARKETING", "REJECT"];

function permissionFor(action: GeoContentAction, state: GeoContentApprovalState): GeoPermission {
	switch (action) {
		case "APPROVE_TECH":
			return "content.review_tech";
		case "APPROVE_MARKETING":
			return "content.review_marketing";
		case "REJECT":
			return state === "PENDING_TECH_REVIEW" ? "content.review_tech" : "content.review_marketing";
		case "PUBLISH":
			return "content.publish";
		default:
			return "content.write";
	}
}

export interface GeoContentTransitionInput {
	/** `authorIds` are everyone who wrote a version; none of them may review it. */
	item: { state: GeoContentApprovalState; authorIds: readonly string[] };
	action: GeoContentAction;
	actor: GeoTransitionActor;
	comment?: string | null;
}

/**
 * Draft → technical review → marketing review → approved → published. Either
 * review can send it back with a comment; a revision is a new immutable version
 * that starts the reviews again.
 */
export function contentTransition(input: GeoContentTransitionInput): GeoTransitionResult<GeoContentApprovalState> {
	const { item, action, actor, comment } = input;
	const to = EDGES[action][item.state];
	if (!to) return fail("CONFLICT", `内容当前状态 ${item.state} 不允许执行 ${action}`);
	if (!actorHolds(actor, permissionFor(action, item.state))) {
		return fail("FORBIDDEN", "当前账号没有执行此操作的权限");
	}
	if (REVIEW_ACTIONS.includes(action) && actor.kind === "principal" && item.authorIds.includes(actor.id)) {
		return fail("FORBIDDEN", "作者不能审核自己撰写的内容");
	}
	if (action === "REJECT" && !hasText(comment)) return fail("VALIDATION_ERROR", "驳回必须填写意见");
	return { ok: true, to };
}

/** Export of a release version is only for content that passed both reviews. */
export function isContentExportable(state: GeoContentApprovalState): boolean {
	return state === "APPROVED" || state === "PUBLISHED";
}
