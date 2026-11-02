import type { GeoPromptSetStatus, GeoPromptStatus } from "./enums";
import type { GeoPermission } from "./permissions";
import { fail, type GeoTransitionActor, type GeoTransitionResult, hasText, actorHolds } from "./transition";

export const GEO_PROMPT_ACTIONS = ["SUBMIT", "APPROVE", "REJECT", "FREEZE", "REVISE"] as const;
export type GeoPromptAction = (typeof GEO_PROMPT_ACTIONS)[number];

const EDGES: Record<GeoPromptAction, Partial<Record<GeoPromptStatus, GeoPromptStatus>>> = {
	SUBMIT: { DRAFT: "IN_REVIEW" },
	APPROVE: { IN_REVIEW: "BASELINE" },
	REJECT: { IN_REVIEW: "REJECTED" },
	FREEZE: { BASELINE: "FROZEN" },
	// Sets keep the revision they froze, so editing starts a new revision and never rewrites one.
	REVISE: { REJECTED: "DRAFT", BASELINE: "DRAFT", FROZEN: "DRAFT" },
};

const ACTION_PERMISSION: Record<GeoPromptAction, GeoPermission> = {
	SUBMIT: "prompt.write",
	APPROVE: "prompt.review",
	REJECT: "prompt.review",
	FREEZE: "prompt.freeze",
	REVISE: "prompt.write",
};

export interface GeoPromptTransitionInput {
	status: GeoPromptStatus;
	action: GeoPromptAction;
	actor: GeoTransitionActor;
	comment?: string | null;
}

export function promptTransition(input: GeoPromptTransitionInput): GeoTransitionResult<GeoPromptStatus> {
	const { status, action, actor, comment } = input;
	const to = EDGES[action][status];
	if (!to) return fail("CONFLICT", `问法当前状态 ${status} 不允许执行 ${action}`);
	if (!actorHolds(actor, ACTION_PERMISSION[action])) return fail("FORBIDDEN", "当前账号没有执行此问法操作的权限");
	if (action === "REJECT" && !hasText(comment)) return fail("VALIDATION_ERROR", "驳回问法必须填写意见");
	return { ok: true, to };
}

/** In-place edits are only for a draft; everything else goes through `REVISE` first. */
export function isPromptEditable(status: GeoPromptStatus): boolean {
	return status === "DRAFT";
}

export function promptSetFreezeTransition(
	status: GeoPromptSetStatus,
	actor: GeoTransitionActor,
	itemCount: number,
): GeoTransitionResult<GeoPromptSetStatus> {
	if (status !== "DRAFT") return fail("CONFLICT", "测试集已冻结，修改必须生成新版本");
	if (!actorHolds(actor, "prompt.freeze")) return fail("FORBIDDEN", "当前账号没有冻结测试集的权限");
	if (itemCount === 0) return fail("VALIDATION_ERROR", "不能冻结空的测试集");
	return { ok: true, to: "FROZEN" };
}
