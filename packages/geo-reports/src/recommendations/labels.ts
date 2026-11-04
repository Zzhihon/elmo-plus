import type { GeoCitedContentType, GeoRecommendationKind, GeoTaskKind } from "@workspace/geo-domain";

export const GEO_CITED_CONTENT_TYPE_LABELS: Record<GeoCitedContentType, string> = {
	PRODUCT_SPEC: "产品手册 / 参数页",
	CASE_STUDY: "成功案例",
	QUALIFICATION: "资质证书",
	COMPANY_PROFILE: "公司介绍",
	NEWS: "企业动态",
	SELECTION_GUIDE: "选型指南",
	DIRECTORY_LISTING: "行业平台 / 企业名录",
	QA_COMMUNITY: "问答社区",
	MEDIA_ARTICLE: "媒体文章",
	OTHER: "其他网页",
};

export const GEO_RECOMMENDATION_KIND_LABELS: Record<GeoRecommendationKind, string> = {
	CONTENT_GAP: "官网需要补充的内容",
	SITE_FIX: "官网技术问题",
	THIRD_PARTY_CHANNEL: "站外渠道",
	FACT_CORRECTION: "AI 说错的地方",
};

/** Content a company publishes on its own site; the other types live on platforms it does not run. */
export const GEO_ON_SITE_CONTENT_TYPES: readonly GeoCitedContentType[] = [
	"PRODUCT_SPEC",
	"CASE_STUDY",
	"QUALIFICATION",
	"SELECTION_GUIDE",
	"COMPANY_PROFILE",
	"NEWS",
];

const TASK_KIND_BY_CONTENT_TYPE: Record<GeoCitedContentType, GeoTaskKind> = {
	PRODUCT_SPEC: "SITE_REVISION",
	CASE_STUDY: "CASE_ADDITION",
	QUALIFICATION: "SITE_REVISION",
	COMPANY_PROFILE: "COMPANY_INTRO",
	NEWS: "OTHER",
	SELECTION_GUIDE: "SELECTION_GUIDE",
	DIRECTORY_LISTING: "OTHER",
	QA_COMMUNITY: "FAQ",
	MEDIA_ARTICLE: "OTHER",
	OTHER: "OTHER",
};

export function taskKindForRecommendation(input: {
	kind: GeoRecommendationKind;
	contentType: GeoCitedContentType | null;
	ruleTaskKind?: GeoTaskKind | null;
}): GeoTaskKind {
	if (input.kind === "FACT_CORRECTION") return "FACT_CORRECTION";
	if (input.kind === "SITE_FIX") return input.ruleTaskKind ?? "SITE_REVISION";
	return input.contentType ? TASK_KIND_BY_CONTENT_TYPE[input.contentType] : "OTHER";
}
