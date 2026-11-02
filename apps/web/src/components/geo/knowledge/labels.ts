import type {
	GeoAssetApprovalStatus,
	GeoAssetType,
	GeoContentAction,
	GeoContentApprovalState,
	GeoContentKind,
	GeoDraftCheckStatus,
	GeoDraftTokenKind,
	GeoKnowledgeClaimType,
	GeoPublicationScope,
	GeoSiteEntityKind,
} from "@workspace/geo-domain";
import type { GeoBadgeTone } from "@/components/geo/shell/status-badge";
import type { ClaimReviewDecision } from "@/server/geo/knowledge-core";

export { errorMessage, formatDateTime } from "@/components/geo/tasks/labels";

export const CLAIM_TYPE_LABELS: Record<GeoKnowledgeClaimType, string> = {
	BRAND_CLAIM: "品牌主张",
	COMPANY_PROFILE: "企业概况",
	PRODUCT_DESCRIPTION: "产品说明",
	TECH_PARAMETER: "技术参数",
	STANDARD: "执行标准",
	CERTIFICATE: "证书",
	QUALIFICATION: "资质",
	PATENT: "专利",
	REGISTERED_CAPITAL: "注册资本",
	PROJECT_RESULT: "项目交付结果",
	PERFORMANCE: "性能指标",
	CASE: "案例",
	SERVICE_COMMITMENT: "服务承诺",
	FAQ: "FAQ",
	NEWS: "新闻",
	OTHER: "其他",
};

export function claimTypeLabel(value: string): string {
	return CLAIM_TYPE_LABELS[value as GeoKnowledgeClaimType] ?? value;
}

/** Suggested field paths, so claims from manuals land on the same field as the website's. */
export const CLAIM_TYPE_FIELD_HINTS: Partial<Record<GeoKnowledgeClaimType, string>> = {
	TECH_PARAMETER: "params.额定电压",
	STANDARD: "standards",
	CERTIFICATE: "certificates.名称",
	QUALIFICATION: "qualifications.名称",
	PATENT: "patents.count",
	REGISTERED_CAPITAL: "company.registeredCapital",
	PROJECT_RESULT: "case.result",
	PRODUCT_DESCRIPTION: "description",
	COMPANY_PROFILE: "company.profile",
	SERVICE_COMMITMENT: "service.commitment",
};

export const ENTITY_KIND_LABELS: Record<GeoSiteEntityKind, string> = {
	PRODUCT: "产品",
	CASE: "案例",
	NEWS: "新闻",
	COMPANY: "企业",
	QUALIFICATION: "资质",
	SERVICE: "服务",
};

export function entityKindLabel(value: string): string {
	return ENTITY_KIND_LABELS[value as GeoSiteEntityKind] ?? value;
}

export const ASSET_TYPE_LABELS: Record<GeoAssetType, string> = {
	BRAND_CLAIM: "品牌主张",
	CERTIFICATE: "资质证书",
	PRODUCT_SPEC: "产品技术资料",
	CASE: "项目案例",
	SERVICE_COMMITMENT: "服务承诺",
	FAQ: "FAQ",
};

export const SCOPE_LABELS: Record<GeoPublicationScope, string> = {
	PUBLIC: "可公开",
	INTERNAL: "仅内部",
	CONFIDENTIAL: "保密",
};

export const SCOPE_TONES: Record<GeoPublicationScope, GeoBadgeTone> = {
	PUBLIC: "success",
	INTERNAL: "neutral",
	CONFIDENTIAL: "danger",
};

export const ASSET_APPROVAL_LABELS: Record<GeoAssetApprovalStatus, string> = {
	PENDING: "待确认",
	APPROVED: "原件已确认",
	REJECTED: "已驳回",
};

export const ASSET_APPROVAL_TONES: Record<GeoAssetApprovalStatus, GeoBadgeTone> = {
	PENDING: "warning",
	APPROVED: "success",
	REJECTED: "danger",
};

export const DECISION_LABELS: Record<ClaimReviewDecision, string> = {
	APPROVE: "审核通过",
	REJECT: "驳回",
	REQUEST_EVIDENCE: "要求补充证据",
	INVALIDATE: "标记失效",
	RESUBMIT: "重新提交审核",
	FREEZE: "冻结",
	UNFREEZE: "解冻",
};

export const CONFLICT_RESOLUTION_LABELS: Record<string, string> = {
	KEEP_APPROVED: "保留原批准值",
	ACCEPT_CANDIDATE: "采用新值",
	SUPERSEDED: "原批准值已失效或被替代",
};

export function conflictResolutionLabel(value: string | null): string {
	if (!value) return "—";
	const [code, ...rest] = value.split(": ");
	const label = CONFLICT_RESOLUTION_LABELS[code] ?? code;
	return rest.length > 0 ? `${label}：${rest.join(": ")}` : label;
}

export const CONTENT_KIND_LABELS: Record<GeoContentKind, string> = {
	FAQ: "产品 FAQ",
	SELECTION_GUIDE: "选型指南",
	CASE: "项目案例",
	COMPANY_INTRO: "企业介绍",
};

export const CONTENT_STATE_LABELS: Record<GeoContentApprovalState, string> = {
	DRAFT: "草稿",
	PENDING_TECH_REVIEW: "待技术审核",
	PENDING_MARKETING_REVIEW: "待市场审核",
	APPROVED: "审核通过",
	REJECTED: "已驳回",
	PUBLISHED: "已发布",
};

export const CONTENT_STATE_TONES: Record<GeoContentApprovalState, GeoBadgeTone> = {
	DRAFT: "neutral",
	PENDING_TECH_REVIEW: "warning",
	PENDING_MARKETING_REVIEW: "warning",
	APPROVED: "success",
	REJECTED: "danger",
	PUBLISHED: "info",
};

export const CONTENT_ACTION_LABELS: Record<GeoContentAction, string> = {
	SUBMIT: "提交技术审核",
	APPROVE_TECH: "技术审核通过",
	APPROVE_MARKETING: "市场审核通过",
	REJECT: "驳回",
	REVISE: "修订",
	PUBLISH: "登记发布",
};

export const CHECK_STATUS_LABELS: Record<GeoDraftCheckStatus, string> = {
	SUPPORTED: "有来源",
	UNCITED: "待证实（未标注来源）",
	UNSUPPORTED: "待证实（找不到来源）",
	MISMATCH: "与来源不一致",
};

export const CHECK_STATUS_TONES: Record<GeoDraftCheckStatus, GeoBadgeTone> = {
	SUPPORTED: "success",
	UNCITED: "warning",
	UNSUPPORTED: "warning",
	MISMATCH: "danger",
};

export const TOKEN_KIND_LABELS: Record<GeoDraftTokenKind, string> = {
	NUMBER: "数字",
	MODEL: "型号",
	STANDARD: "标准号",
	CERTIFICATE: "证书",
};

export function valueText(value: string | string[] | string[][] | null): string {
	if (value === null) return "—";
	if (typeof value === "string") return value;
	if (value.length > 0 && Array.isArray(value[0]))
		return (value as string[][]).map((row) => row.join(" | ")).join("\n");
	return (value as string[]).join("；");
}

export function formatDate(value: string | null | undefined): string {
	if (!value) return "长期有效";
	return new Date(value).toLocaleDateString("zh-CN");
}

export function formatBytes(size: number | null): string {
	if (!size) return "—";
	if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} KB`;
	return `${(size / 1024 / 1024).toFixed(1)} MB`;
}
