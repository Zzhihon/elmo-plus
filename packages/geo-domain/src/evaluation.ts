import type { GeoClaimVerdict, GeoPriority, GeoRecommendation, GeoReportStatus } from "./enums";

export const GEO_CITATION_OWNERS = ["OWN", "COMPETITOR", "THIRD_PARTY"] as const;
export type GeoCitationOwner = (typeof GEO_CITATION_OWNERS)[number];

export const GEO_CLAIM_KINDS = ["NUMBER", "MODEL", "CERTIFICATE"] as const;
export type GeoClaimKind = (typeof GEO_CLAIM_KINDS)[number];

/** How an answer's claim compared with approved knowledge; only a technical review turns it into an error. */
export const GEO_CLAIM_MATCH_STATUSES = ["MATCHED", "MISMATCH", "NO_REFERENCE"] as const;
export type GeoClaimMatchStatus = (typeof GEO_CLAIM_MATCH_STATUSES)[number];

export const GEO_REVIEW_REASONS = [
	"LLM_DISAGREES",
	"LOW_CONFIDENCE",
	"HIGH_PRIORITY_PROMPT",
	"TECHNICAL_CLAIM",
	"CLAIM_MISMATCH",
	"RULES_ONLY_JUDGEMENT",
] as const;
export type GeoReviewReason = (typeof GEO_REVIEW_REASONS)[number];

export const GEO_REPORT_REVIEW_STATUSES = ["PENDING", "APPROVED", "REJECTED"] as const;
export type GeoReportReviewStatus = (typeof GEO_REPORT_REVIEW_STATUSES)[number];

/** Prompts at these priorities are high-value purchase questions: their evaluations always get a human look. */
export const GEO_HIGH_PRIORITY_PROMPTS: readonly GeoPriority[] = ["P0", "P1"];

export const GEO_CITATION_OWNER_LABELS: Record<GeoCitationOwner, string> = {
	OWN: "自有品牌",
	COMPETITOR: "竞品",
	THIRD_PARTY: "第三方",
};

export const GEO_CLAIM_KIND_LABELS: Record<GeoClaimKind, string> = {
	NUMBER: "数字参数",
	MODEL: "产品型号",
	CERTIFICATE: "证书认证",
};

export const GEO_CLAIM_MATCH_LABELS: Record<GeoClaimMatchStatus, string> = {
	MATCHED: "与已审核知识一致",
	MISMATCH: "与已审核知识不一致",
	NO_REFERENCE: "无可比对的已审核知识",
};

export const GEO_CLAIM_VERDICT_LABELS: Record<GeoClaimVerdict, string> = {
	UNVERIFIED: "待核实",
	CORRECT: "正确",
	ERROR: "经技术审核确认错误",
};

export const GEO_REVIEW_REASON_LABELS: Record<GeoReviewReason, string> = {
	LLM_DISAGREES: "模型判断与规则不一致",
	LOW_CONFIDENCE: "置信度低",
	HIGH_PRIORITY_PROMPT: "高优先级问法",
	TECHNICAL_CLAIM: "含技术参数断言",
	CLAIM_MISMATCH: "断言与已审核知识不一致",
	RULES_ONLY_JUDGEMENT: "推荐或负面结论仅由规则得出",
};

export const GEO_REPORT_STATUS_LABELS: Record<GeoReportStatus, string> = {
	QUEUED: "排队中",
	RUNNING: "生成中",
	SUCCEEDED: "已生成",
	FAILED: "生成失败",
};

export const GEO_REPORT_REVIEW_LABELS: Record<GeoReportReviewStatus, string> = {
	PENDING: "待审核",
	APPROVED: "已审核",
	REJECTED: "已驳回",
};

export type GeoEvidenceSpanKind = "BRAND" | "COMPETITOR" | "RECOMMENDATION" | "NEGATIVE" | "RANK" | "CLAIM";

/** Offsets index the answer text as stored, so a reviewer sees exactly the words a conclusion rests on. */
export interface GeoEvidenceSpan {
	kind: GeoEvidenceSpanKind;
	start: number;
	end: number;
	text: string;
	entityId?: string | null;
}

export interface GeoCompetitorHit {
	entityId: string;
	name: string;
	mentioned: boolean;
	recommendation: GeoRecommendation;
	rank: number | null;
}

export interface GeoCitationAttribution {
	ordinal: number;
	normalizedUrl: string | null;
	host: string | null;
	owner: GeoCitationOwner;
	entityId: string | null;
}

export interface GeoRuleSignals {
	recommendation: GeoRecommendation;
	confidence: number;
	cues: string[];
}

export interface GeoLlmSignals {
	model: string | null;
	brandMentioned: boolean;
	recommendation: GeoRecommendation;
	hasOrderedList: boolean;
	brandRank: number | null;
	confidence: number;
	evidenceQuote: string | null;
	quoteFound: boolean;
}

/** What each layer concluded on its own, kept beside the merged result so a reviewer can see why it was flagged. */
export interface GeoEvaluationSignals {
	rules: GeoRuleSignals;
	llm: GeoLlmSignals | { error: string } | null;
	productHits: string[];
}
