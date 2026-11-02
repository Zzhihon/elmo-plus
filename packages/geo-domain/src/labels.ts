import type {
	GeoAssertionStatus,
	GeoBatchStatus,
	GeoBrandKind,
	GeoEvaluationReviewStatus,
	GeoFactStatus,
	GeoPlatform,
	GeoPromptStatus,
	GeoPromptTier,
	GeoRecommendation,
	GeoRunStatus,
	GeoSurfaceMode,
	GeoTaskState,
	GeoTermKind,
	GeoVerificationStatus,
} from "./enums";
import type { GeoRole } from "./permissions";

export const GEO_ROLE_LABELS: Record<GeoRole, string> = {
	platform_admin: "平台管理员",
	geo_operator: "GEO 运营",
	tech_reviewer: "技术审核人",
	marketing_reviewer: "市场审核人",
	knowledge_reviewer: "知识审核员",
	viewer: "只读用户",
};

export const GEO_PLATFORM_LABELS: Record<GeoPlatform, string> = {
	doubao: "豆包",
	deepseek: "DeepSeek",
	yuanbao: "腾讯元宝",
	qwen: "通义千问",
};

export const GEO_SURFACE_MODE_LABELS: Record<GeoSurfaceMode, string> = {
	LIVE_SURFACE: "用户界面实测",
	MODEL_API: "模型 API 代理评测",
	MANUAL_EVIDENCE: "人工证据",
};

export const GEO_VERIFICATION_LABELS: Record<GeoVerificationStatus, string> = {
	UNVERIFIED: "未验证",
	LIMITED: "限制可用",
	PASSED: "已通过",
	FAILED: "未通过",
};

export const GEO_TASK_STATE_LABELS: Record<GeoTaskState, string> = {
	PENDING_ANALYSIS: "待分析",
	PENDING_ASSIGNMENT: "待指派",
	IN_PROGRESS: "进行中",
	PENDING_TECH_REVIEW: "待技术审核",
	PENDING_MARKETING_REVIEW: "待市场审核",
	PENDING_PUBLISH: "待发布",
	PUBLISHED: "已发布/已实施",
	PENDING_RETEST: "待复测",
	VERIFIED: "已验证",
	REJECTED: "已驳回",
	PAUSED: "已暂停",
	CANCELLED: "已取消",
};

export const GEO_ASSERTION_STATUS_LABELS: Record<GeoAssertionStatus, string> = {
	DISCOVERED: "已发现",
	PARSED: "已解析",
	PENDING_REVIEW: "待审核",
	APPROVED: "已审核",
	REJECTED: "已驳回",
	NEEDS_EVIDENCE: "待补证据",
	SUPERSEDED: "已替代",
	SOURCE_UNAVAILABLE: "来源不可用待复核",
};

export const GEO_BRAND_KIND_LABELS: Record<GeoBrandKind, string> = {
	OWN: "自有品牌",
	COMPETITOR: "竞品",
};

export const GEO_TERM_KIND_LABELS: Record<GeoTermKind, string> = {
	GENERIC: "通用产品词",
	CUSTOMER_MODEL: "客户型号",
};

/** On a brand or product these describe customer sign-off, not a reviewed knowledge assertion. */
export const GEO_FACT_STATUS_LABELS: Record<GeoFactStatus, string> = {
	UNVERIFIED: "待客户确认",
	PENDING_REVIEW: "审核中",
	APPROVED: "客户已确认",
	REJECTED: "已驳回",
};

export const GEO_PROMPT_TIER_LABELS: Record<GeoPromptTier, string> = {
	CORE: "核心问法",
	EXTENDED: "扩展问法",
};

export const GEO_PROMPT_STATUS_LABELS: Record<GeoPromptStatus, string> = {
	DRAFT: "草稿",
	IN_REVIEW: "业务审核中",
	BASELINE: "入选基线",
	FROZEN: "已冻结",
	REJECTED: "已驳回",
};

export const GEO_BATCH_STATUS_LABELS: Record<GeoBatchStatus, string> = {
	PLANNED: "已计划",
	RUNNING: "运行中",
	PAUSED: "已暂停",
	COMPLETED: "已完成",
	PARTIAL: "部分完成",
	FAILED: "失败",
	CANCELLED: "已取消",
};

export const GEO_RUN_STATUS_LABELS: Record<GeoRunStatus, string> = {
	PLANNED: "已计划",
	RUNNING: "运行中",
	VALID: "有效",
	PARTIAL: "部分成功",
	UNAVAILABLE: "不可用",
	NEEDS_MANUAL: "待人工处理",
	FAILED: "失败",
	RATE_LIMITED: "被限流",
	TIMEOUT: "超时",
	CAPTCHA: "需要验证码",
	NETWORK_ERROR: "网络错误",
};

export const GEO_RECOMMENDATION_LABELS: Record<GeoRecommendation, string> = {
	RECOMMENDED: "明确推荐",
	MENTIONED_ONLY: "仅提及",
	NEGATIVE: "负面警示",
	NOT_MENTIONED: "未提及",
};

export const GEO_EVALUATION_REVIEW_LABELS: Record<GeoEvaluationReviewStatus, string> = {
	AUTO_ACCEPTED: "自动接受",
	PENDING_REVIEW: "待复核",
	CONFIRMED: "已确认",
	CORRECTED: "已更正",
};
