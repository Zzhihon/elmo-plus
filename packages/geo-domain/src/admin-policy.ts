import type { GeoAdminRequestKind, GeoAdminRequestStatus } from "./enums";
import type { GeoPermission } from "./permissions";
import { actorHolds, fail, type GeoTransitionActor, type GeoTransitionResult, hasText } from "./transition";

export const GEO_ADMIN_REQUEST_KIND_LABELS: Record<GeoAdminRequestKind, string> = {
	LLM_USE_APPROVAL: "启用 LLM 调用",
	RETENTION_CHANGE: "保留期变更",
	ADMIN_MFA_POLICY: "关闭管理员 MFA 要求",
};

export const GEO_ADMIN_REQUEST_STATUS_LABELS: Record<GeoAdminRequestStatus, string> = {
	PENDING: "待审批",
	APPROVED: "已批准",
	REJECTED: "已驳回",
	CANCELLED: "已撤回",
	EXPIRED: "已过期",
};

/** A request nobody has decided on starts alerting after this, and lapses after the TTL. */
export const GEO_ADMIN_REQUEST_OVERDUE_HOURS = 48;
export const GEO_ADMIN_REQUEST_TTL_HOURS = 7 * 24;
export const GEO_TASK_REVIEW_OVERDUE_HOURS = 72;
/** A daily backup plus two hours of slack before the 24-hour RPO is at risk. */
export const GEO_BACKUP_STALE_HOURS = 26;

const DECISION_PERMISSION: Record<GeoAdminRequestKind, GeoPermission> = {
	LLM_USE_APPROVAL: "llm.approve",
	RETENTION_CHANGE: "settings.manage",
	ADMIN_MFA_POLICY: "settings.manage",
};

export function adminRequestPermission(kind: GeoAdminRequestKind): GeoPermission {
	return DECISION_PERMISSION[kind];
}

export type GeoAdminRequestDecision = "APPROVE" | "REJECT" | "CANCEL";

export interface GeoAdminRequestFacts {
	kind: GeoAdminRequestKind;
	status: GeoAdminRequestStatus;
	requestedBy: string;
	expiresAt: Date;
}

/**
 * Dual control: whoever asked for a change can withdraw it but never decide it,
 * whatever roles they hold, so one administrator cannot both propose and approve.
 */
export function decideAdminRequest(input: {
	request: GeoAdminRequestFacts;
	decision: GeoAdminRequestDecision;
	actor: GeoTransitionActor;
	comment?: string | null;
	now?: Date;
}): GeoTransitionResult<GeoAdminRequestStatus> {
	const { request, decision, actor, comment } = input;
	const now = input.now ?? new Date();
	if (request.status !== "PENDING") return fail("CONFLICT", "该申请已处理");
	if (actor.kind !== "principal") return fail("FORBIDDEN", "审批必须由具名管理员完成");

	if (decision === "CANCEL") {
		return actor.id === request.requestedBy
			? { ok: true, to: "CANCELLED" }
			: fail("FORBIDDEN", "只有申请人可以撤回申请");
	}

	if (request.expiresAt.getTime() <= now.getTime()) return fail("CONFLICT", "该申请已过期，请重新发起");
	if (!actorHolds(actor, DECISION_PERMISSION[request.kind])) {
		return fail("FORBIDDEN", "当前账号没有审批此申请的权限");
	}
	if (actor.id === request.requestedBy) return fail("FORBIDDEN", "申请人不能审批自己的申请，需要另一位管理员审批");
	if (decision === "REJECT" && !hasText(comment)) return fail("VALIDATION_ERROR", "驳回必须填写意见");
	return { ok: true, to: decision === "APPROVE" ? "APPROVED" : "REJECTED" };
}

export type GeoRetentionCategory = "evidence" | "snapshot" | "audit";

export interface GeoRetentionSettings {
	evidenceRetentionDays: number | null;
	snapshotRetentionDays: number | null;
	auditRetentionDays: number | null;
}

/** Below these a purge could remove evidence a monthly report or an audit still leans on. */
export const GEO_RETENTION_MINIMUM_DAYS: Record<GeoRetentionCategory, number> = {
	evidence: 30,
	snapshot: 30,
	audit: 180,
};

export const GEO_RETENTION_MAXIMUM_DAYS = 3650;

const SETTING_OF: Record<GeoRetentionCategory, keyof GeoRetentionSettings> = {
	evidence: "evidenceRetentionDays",
	snapshot: "snapshotRetentionDays",
	audit: "auditRetentionDays",
};

export const GEO_RETENTION_LABELS: Record<GeoRetentionCategory, string> = {
	evidence: "采样证据",
	snapshot: "官网原始快照",
	audit: "审计日志",
};

export function retentionProblem(settings: GeoRetentionSettings): string | null {
	for (const category of Object.keys(SETTING_OF) as GeoRetentionCategory[]) {
		const days = settings[SETTING_OF[category]];
		if (days === null) continue;
		if (!Number.isInteger(days)) return `${GEO_RETENTION_LABELS[category]}保留期必须是整数天`;
		if (days < GEO_RETENTION_MINIMUM_DAYS[category]) {
			return `${GEO_RETENTION_LABELS[category]}保留期不能少于 ${GEO_RETENTION_MINIMUM_DAYS[category]} 天`;
		}
		if (days > GEO_RETENTION_MAXIMUM_DAYS) {
			return `${GEO_RETENTION_LABELS[category]}保留期不能超过 ${GEO_RETENTION_MAXIMUM_DAYS} 天`;
		}
	}
	return null;
}

/**
 * Rows strictly older than the returned instant may go. Null means keep forever,
 * which is also the answer for a setting below the minimum: a value that slipped
 * past validation must not widen what gets deleted.
 */
export function retentionCutoff(
	settings: GeoRetentionSettings,
	category: GeoRetentionCategory,
	now: Date = new Date(),
): Date | null {
	const days = settings[SETTING_OF[category]];
	if (days === null || !Number.isInteger(days) || days < GEO_RETENTION_MINIMUM_DAYS[category]) return null;
	return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}
