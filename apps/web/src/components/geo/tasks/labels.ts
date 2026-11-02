import type {
	GeoPriority,
	GeoRiskLevel,
	GeoScanStatus,
	GeoTaskAction,
	GeoTaskKind,
	GeoTaskSourceKind,
	GeoTaskState,
} from "@workspace/geo-domain";

export const TASK_KIND_LABELS: Record<GeoTaskKind, string> = {
	SELECTION_GUIDE: "产品选型说明",
	CASE_ADDITION: "案例补充",
	FAQ: "FAQ",
	COMPANY_INTRO: "企业介绍",
	SITE_REVISION: "官网修订",
	FACT_CORRECTION: "事实纠错",
	OTHER: "其他",
};

export const PRIORITY_LABELS: Record<GeoPriority, string> = {
	P0: "P0 紧急",
	P1: "P1 高",
	P2: "P2 中",
	P3: "P3 低",
};

export const RISK_LABELS: Record<GeoRiskLevel, string> = {
	HIGH: "高风险",
	NORMAL: "普通",
};

export const SOURCE_KIND_LABELS: Record<GeoTaskSourceKind, string> = {
	OBSERVATION: "采样证据",
	FINDING: "站点审计发现",
	ASSERTION: "知识断言",
	MANUAL: "手动创建",
};

export const ACTION_LABELS: Record<GeoTaskAction, string> = {
	TRIAGE: "完成分析",
	ASSIGN: "指派",
	SUBMIT_FOR_REVIEW: "提交技术审核",
	APPROVE_TECH: "技术审核通过",
	APPROVE_MARKETING: "市场审核通过",
	REJECT: "驳回",
	REWORK: "退回修改",
	PUBLISH: "登记发布",
	REQUEST_RETEST: "申请复测",
	VERIFY: "确认验证结论",
	REOPEN: "复测未达预期，重新处理",
	PAUSE: "暂停",
	RESUME: "恢复",
	CANCEL: "取消",
};

/** Event actions that are not state-machine actions. */
export const EVENT_ACTION_LABELS: Record<string, string> = {
	...ACTION_LABELS,
	CREATE: "创建工单",
	UPDATE: "修改工单",
	LINK_RETEST_BATCH: "关联复测批次",
};

export const BOARD_COLUMNS: GeoTaskState[] = [
	"PENDING_ANALYSIS",
	"PENDING_ASSIGNMENT",
	"IN_PROGRESS",
	"PENDING_TECH_REVIEW",
	"PENDING_MARKETING_REVIEW",
	"PENDING_PUBLISH",
	"PUBLISHED",
	"PENDING_RETEST",
	"VERIFIED",
	"REJECTED",
	"PAUSED",
	"CANCELLED",
];

export const SCAN_STATUS_LABELS: Record<GeoScanStatus, string> = {
	PENDING: "扫描中",
	CLEAN: "已扫描",
	INFECTED: "发现恶意内容",
	UNSCANNED: "未扫描",
};

export function formatDateTime(value: string | null | undefined): string {
	if (!value) return "—";
	return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

export function errorMessage(error: unknown): string {
	return error instanceof Error && error.message ? error.message : "操作失败，请稍后重试";
}
