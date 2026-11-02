import type { GeoPriority, GeoPromptSetStatus, GeoPromptStatus, GeoPromptTier } from "./enums";
import type { GeoPermission } from "./permissions";
import { actorHolds, fail, type GeoTransitionActor, type GeoTransitionResult, hasText } from "./transition";

/** Copied onto a set item when it freezes, so a later edit to the prompt cannot change a past round. */
export interface GeoPromptLabels {
	buyerRoleId: string | null;
	buyerRoleCode: string | null;
	buyerRoleTitle: string | null;
	intent: string | null;
	productLine: string | null;
	geoRegion: string | null;
	priority: GeoPriority;
	language: string;
	tier: GeoPromptTier;
	ownerId: string | null;
}

export interface GeoPromptRevisionSnapshot extends GeoPromptLabels {
	question: string;
	sourceNote: string | null;
}

/** Null when the prompt carries every label a business review needs. */
export function promptLabelsProblem(labels: {
	buyerRoleId: string | null;
	intent: string | null;
	productLine: string | null;
	geoRegion: string | null;
}): string | null {
	const missing = [
		!labels.buyerRoleId && "买方角色",
		!hasText(labels.intent) && "意图",
		!hasText(labels.productLine) && "产品线",
		!hasText(labels.geoRegion) && "地区",
	].filter(Boolean);
	return missing.length > 0 ? `提交审核前必须填写：${missing.join("、")}` : null;
}

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
	/** Whoever wrote or owns the prompt: they may not be the one to approve it. */
	authorIds?: readonly string[];
}

const REVIEW_ACTIONS: readonly GeoPromptAction[] = ["APPROVE", "REJECT"];

export function promptTransition(input: GeoPromptTransitionInput): GeoTransitionResult<GeoPromptStatus> {
	const { status, action, actor, comment, authorIds } = input;
	const to = EDGES[action][status];
	if (!to) return fail("CONFLICT", `问法当前状态 ${status} 不允许执行 ${action}`);
	if (!actorHolds(actor, ACTION_PERMISSION[action])) return fail("FORBIDDEN", "当前账号没有执行此问法操作的权限");
	if (REVIEW_ACTIONS.includes(action) && actor.kind === "principal" && authorIds?.includes(actor.id)) {
		return fail("FORBIDDEN", "不能审核自己编写或负责的问法");
	}
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
