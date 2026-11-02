import type { GeoBatchStatus, GeoContentApprovalState, GeoRiskLevel, GeoTaskKind } from "./enums";
import type { GeoTaskAction } from "./task-state";
import { type GeoTransitionFailureCode, hasText } from "./transition";

/**
 * Checks that need stored facts the state machine does not see: the launch plan,
 * linked content and the sampling batches a retest compares. They run in addition
 * to `taskTransition`, never instead of it.
 */

export interface GeoTaskLaunchPlan {
	launchApprovalRef: string | null;
	backupPlan: string | null;
	rollbackPlan: string | null;
}

export function requiresLaunchPlan(kind: GeoTaskKind, riskLevel: GeoRiskLevel): boolean {
	return kind === "SITE_REVISION" && riskLevel === "HIGH";
}

export function launchPlanProblem(task: { kind: GeoTaskKind; riskLevel: GeoRiskLevel } & GeoTaskLaunchPlan) {
	if (!requiresLaunchPlan(task.kind, task.riskLevel)) return null;
	const missing = [
		hasText(task.launchApprovalRef) ? null : "上线审批编号",
		hasText(task.backupPlan) ? null : "备份方案",
		hasText(task.rollbackPlan) ? null : "回滚计划",
	].filter((item): item is string => item !== null);
	return missing.length === 0 ? null : `高风险官网改造进入待发布前必须填写：${missing.join("、")}`;
}

export interface GeoBatchFacts {
	id: string;
	promptSetId: string;
	createdAt: Date;
	status: GeoBatchStatus;
}

const SETTLED_BATCH: readonly GeoBatchStatus[] = ["COMPLETED", "PARTIAL"];
const PUBLISHABLE_CONTENT: readonly GeoContentApprovalState[] = ["APPROVED", "PUBLISHED"];
/** Tolerates a publisher's clock running a little ahead of the server's. */
const CLOCK_SKEW_MS = 5 * 60 * 1000;

export interface GeoTaskGateInput {
	action: GeoTaskAction;
	task: { kind: GeoTaskKind; riskLevel: GeoRiskLevel; createdAt: Date; publishedAt: Date | null } & GeoTaskLaunchPlan;
	payload?: { publishedUrl?: string | null; publishedAt?: Date | null };
	/** Approval states of content items linked to the task. */
	contentStates?: readonly GeoContentApprovalState[];
	before?: GeoBatchFacts | null;
	after?: GeoBatchFacts | null;
	now?: Date;
}

export interface GeoTaskGateProblem {
	code: GeoTransitionFailureCode;
	message: string;
}

function problem(code: GeoTransitionFailureCode, message: string): GeoTaskGateProblem {
	return { code, message };
}

export function isHttpUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return (url.protocol === "http:" || url.protocol === "https:") && url.hostname.length > 0;
	} catch {
		return false;
	}
}

function publishProblem(input: GeoTaskGateInput, now: Date): GeoTaskGateProblem | null {
	const { task, payload = {}, contentStates = [] } = input;
	const plan = launchPlanProblem(task);
	if (plan) return problem("EVIDENCE_REQUIRED", plan);
	if (hasText(payload.publishedUrl) && !isHttpUrl(payload.publishedUrl as string)) {
		return problem("VALIDATION_ERROR", "发布 URL 必须是 http 或 https 地址");
	}
	if (!payload.publishedAt) return problem("EVIDENCE_REQUIRED", "发布必须登记实际发布时间");
	if (payload.publishedAt.getTime() > now.getTime() + CLOCK_SKEW_MS) {
		return problem("VALIDATION_ERROR", "发布时间不能晚于当前时间");
	}
	if (payload.publishedAt.getTime() < task.createdAt.getTime()) {
		return problem("VALIDATION_ERROR", "发布时间不能早于工单创建时间");
	}
	if (contentStates.some((state) => !PUBLISHABLE_CONTENT.includes(state))) {
		return problem("CONFLICT", "关联内容尚未通过审核，不能登记发布");
	}
	return null;
}

function verifyProblem(input: GeoTaskGateInput): GeoTaskGateProblem | null {
	const { task, before, after } = input;
	if (!before || !after) return problem("EVIDENCE_REQUIRED", "验证必须关联复测前后的采样批次");
	if (before.id === after.id) return problem("VALIDATION_ERROR", "复测前后必须是两个不同的采样批次");
	if (before.promptSetId !== after.promptSetId) {
		return problem("VALIDATION_ERROR", "复测前后批次必须使用同一问法集版本，否则结果不可比");
	}
	if (!SETTLED_BATCH.includes(before.status) || !SETTLED_BATCH.includes(after.status)) {
		return problem("CONFLICT", "复测前后批次都必须已完成采样");
	}
	if (!task.publishedAt) return problem("CONFLICT", "工单尚未登记发布，不能验证");
	if (after.createdAt.getTime() <= task.publishedAt.getTime()) {
		return problem("VALIDATION_ERROR", "复测批次必须在发布之后创建");
	}
	if (before.createdAt.getTime() > task.publishedAt.getTime()) {
		return problem("VALIDATION_ERROR", "基线批次必须在发布之前创建");
	}
	return null;
}

export function taskGateProblem(input: GeoTaskGateInput): GeoTaskGateProblem | null {
	const now = input.now ?? new Date();
	switch (input.action) {
		case "APPROVE_MARKETING": {
			const plan = launchPlanProblem(input.task);
			return plan ? problem("EVIDENCE_REQUIRED", plan) : null;
		}
		case "PUBLISH":
			return publishProblem(input, now);
		case "VERIFY":
			return verifyProblem(input);
		default:
			return null;
	}
}
