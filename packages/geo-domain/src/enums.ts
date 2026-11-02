export const GEO_ACTOR_KINDS = ["user", "api_key", "instance_admin_key", "system"] as const;
export type GeoActorKind = (typeof GEO_ACTOR_KINDS)[number];

export const GEO_BRAND_KINDS = ["OWN", "COMPETITOR"] as const;
export type GeoBrandKind = (typeof GEO_BRAND_KINDS)[number];

export const GEO_ACTIVE_STATUSES = ["ACTIVE", "DISABLED"] as const;
export type GeoActiveStatus = (typeof GEO_ACTIVE_STATUSES)[number];

export const GEO_TERM_KINDS = ["GENERIC", "CUSTOMER_MODEL"] as const;
export type GeoTermKind = (typeof GEO_TERM_KINDS)[number];

export const GEO_FACT_STATUSES = ["UNVERIFIED", "PENDING_REVIEW", "APPROVED", "REJECTED"] as const;
export type GeoFactStatus = (typeof GEO_FACT_STATUSES)[number];

export const GEO_PRIORITIES = ["P0", "P1", "P2", "P3"] as const;
export type GeoPriority = (typeof GEO_PRIORITIES)[number];

export const GEO_PROMPT_STATUSES = ["DRAFT", "IN_REVIEW", "BASELINE", "FROZEN", "REJECTED"] as const;
export type GeoPromptStatus = (typeof GEO_PROMPT_STATUSES)[number];

export const GEO_PROMPT_TIERS = ["CORE", "EXTENDED"] as const;
export type GeoPromptTier = (typeof GEO_PROMPT_TIERS)[number];

export const GEO_PROMPT_SET_STATUSES = ["DRAFT", "FROZEN"] as const;
export type GeoPromptSetStatus = (typeof GEO_PROMPT_SET_STATUSES)[number];

export const GEO_PLATFORMS = ["doubao", "deepseek", "yuanbao", "qwen"] as const;
export type GeoPlatform = (typeof GEO_PLATFORMS)[number];

export const GEO_SURFACE_MODES = ["LIVE_SURFACE", "MODEL_API", "MANUAL_EVIDENCE"] as const;
export type GeoSurfaceMode = (typeof GEO_SURFACE_MODES)[number];

export const GEO_BREAKER_STATES = ["CLOSED", "OPEN", "HALF_OPEN"] as const;
export type GeoBreakerState = (typeof GEO_BREAKER_STATES)[number];

export const GEO_VERIFICATION_STATUSES = ["UNVERIFIED", "LIMITED", "PASSED", "FAILED"] as const;
export type GeoVerificationStatus = (typeof GEO_VERIFICATION_STATUSES)[number];

export const GEO_BATCH_STATUSES = [
	"PLANNED",
	"RUNNING",
	"PAUSED",
	"COMPLETED",
	"PARTIAL",
	"FAILED",
	"CANCELLED",
] as const;
export type GeoBatchStatus = (typeof GEO_BATCH_STATUSES)[number];

export const GEO_RUN_STATUSES = [
	"PLANNED",
	"RUNNING",
	"VALID",
	"PARTIAL",
	"UNAVAILABLE",
	"NEEDS_MANUAL",
	"FAILED",
	"RATE_LIMITED",
	"TIMEOUT",
	"NETWORK_ERROR",
	"CAPTCHA",
] as const;
export type GeoRunStatus = (typeof GEO_RUN_STATUSES)[number];

export const GEO_ATTEMPT_STATUSES = [
	"RUNNING",
	"VALID",
	"PARTIAL",
	"UNAVAILABLE",
	"NEEDS_MANUAL",
	"FAILED",
	"RATE_LIMITED",
	"TIMEOUT",
	"NETWORK_ERROR",
	"CAPTCHA",
] as const;
export type GeoAttemptStatus = (typeof GEO_ATTEMPT_STATUSES)[number];

export const GEO_OBSERVATION_STATUSES = [
	"VALID",
	"PARTIAL",
	"UNAVAILABLE",
	"NEEDS_MANUAL",
	"FAILED",
	"RATE_LIMITED",
	"TIMEOUT",
	"NETWORK_ERROR",
	"CAPTCHA",
] as const;
export type GeoObservationStatus = (typeof GEO_OBSERVATION_STATUSES)[number];

export const GEO_RETRY_RELATIONS = ["AUTO_RETRY", "EXPLICIT_RESAMPLE"] as const;
export type GeoRetryRelation = (typeof GEO_RETRY_RELATIONS)[number];

export const GEO_RECOMMENDATIONS = ["RECOMMENDED", "MENTIONED_ONLY", "NEGATIVE", "NOT_MENTIONED"] as const;
export type GeoRecommendation = (typeof GEO_RECOMMENDATIONS)[number];

export const GEO_EVALUATION_REVIEW_STATUSES = ["AUTO_ACCEPTED", "PENDING_REVIEW", "CONFIRMED", "CORRECTED"] as const;
export type GeoEvaluationReviewStatus = (typeof GEO_EVALUATION_REVIEW_STATUSES)[number];

export const GEO_CLAIM_VERDICTS = ["UNVERIFIED", "CORRECT", "ERROR"] as const;
export type GeoClaimVerdict = (typeof GEO_CLAIM_VERDICTS)[number];

export const GEO_CRAWL_MODES = ["FULL", "INCREMENTAL"] as const;
export type GeoCrawlMode = (typeof GEO_CRAWL_MODES)[number];

export const GEO_CRAWL_STATUSES = [
	"QUEUED",
	"RUNNING",
	"PAUSED",
	"SUCCEEDED",
	"PARTIAL",
	"FAILED",
	"CANCELLED",
] as const;
export type GeoCrawlStatus = (typeof GEO_CRAWL_STATUSES)[number];

export const GEO_SITE_PAGE_STATUSES = ["ACTIVE", "REDIRECTED", "GONE", "BLOCKED", "ERROR"] as const;
export type GeoSitePageStatus = (typeof GEO_SITE_PAGE_STATUSES)[number];

export const GEO_PARSE_STATUSES = ["PENDING", "PARSED", "FAILED", "SKIPPED"] as const;
export type GeoParseStatus = (typeof GEO_PARSE_STATUSES)[number];

export const GEO_SITE_ENTITY_KINDS = ["PRODUCT", "CASE", "NEWS", "COMPANY", "QUALIFICATION", "SERVICE"] as const;
export type GeoSiteEntityKind = (typeof GEO_SITE_ENTITY_KINDS)[number];

export const GEO_SITE_ENTITY_STATUSES = ["CANDIDATE", "CONFIRMED", "REJECTED", "SOURCE_UNAVAILABLE"] as const;
export type GeoSiteEntityStatus = (typeof GEO_SITE_ENTITY_STATUSES)[number];

export const GEO_CRAWL_ITEM_STATUSES = ["QUEUED", "FETCHING", "DONE", "FAILED", "SKIPPED"] as const;
export type GeoCrawlItemStatus = (typeof GEO_CRAWL_ITEM_STATUSES)[number];

/** What one URL in a crawl run came to. */
export const GEO_CRAWL_ITEM_OUTCOMES = [
	"NEW_VERSION",
	"UNCHANGED",
	"DUPLICATE",
	"REDIRECTED",
	"GONE",
	"AUTH_REQUIRED",
	"CLIENT_ERROR",
	"SERVER_ERROR",
	"NETWORK_ERROR",
	"REDIRECT_BLOCKED",
	"ADDRESS_BLOCKED",
	"MIME_REJECTED",
	"TOO_LARGE",
	"ROBOTS_DISALLOWED",
	"OUT_OF_SCOPE",
	"NOFOLLOW",
	"BUDGET_EXCEEDED",
	"ASSET_RECORDED",
	"ASSET_STORED",
	"CIRCUIT_OPEN",
] as const;
export type GeoCrawlItemOutcome = (typeof GEO_CRAWL_ITEM_OUTCOMES)[number];

export const GEO_CRAWL_ITEM_SOURCES = [
	"SEED",
	"SITEMAP",
	"KNOWN",
	"LINK",
	"PAGINATION",
	"CANONICAL",
	"REDIRECT",
] as const;
export type GeoCrawlItemSource = (typeof GEO_CRAWL_ITEM_SOURCES)[number];

export const GEO_SITE_QA_SAMPLE_STATUSES = ["OPEN", "COMPLETED"] as const;
export type GeoSiteQaSampleStatus = (typeof GEO_SITE_QA_SAMPLE_STATUSES)[number];

export const GEO_SITE_QA_VERDICTS = ["CORRECT", "INCORRECT", "NOT_APPLICABLE"] as const;
export type GeoSiteQaVerdict = (typeof GEO_SITE_QA_VERDICTS)[number];

export const GEO_SITE_AUDIT_RUN_STATUSES = ["QUEUED", "RUNNING", "SUCCEEDED", "FAILED"] as const;
export type GeoSiteAuditRunStatus = (typeof GEO_SITE_AUDIT_RUN_STATUSES)[number];

export const GEO_FINDING_SEVERITIES = ["HIGH", "MEDIUM", "LOW", "INFO"] as const;
export type GeoFindingSeverity = (typeof GEO_FINDING_SEVERITIES)[number];

export const GEO_FINDING_STATUSES = ["OPEN", "TASKED", "RESOLVED", "DISMISSED"] as const;
export type GeoFindingStatus = (typeof GEO_FINDING_STATUSES)[number];

export const GEO_ASSET_TYPES = [
	"BRAND_CLAIM",
	"CERTIFICATE",
	"PRODUCT_SPEC",
	"CASE",
	"SERVICE_COMMITMENT",
	"FAQ",
] as const;
export type GeoAssetType = (typeof GEO_ASSET_TYPES)[number];

export const GEO_SCAN_STATUSES = ["PENDING", "CLEAN", "INFECTED", "UNSCANNED"] as const;
export type GeoScanStatus = (typeof GEO_SCAN_STATUSES)[number];

export const GEO_ASSET_APPROVAL_STATUSES = ["PENDING", "APPROVED", "REJECTED"] as const;
export type GeoAssetApprovalStatus = (typeof GEO_ASSET_APPROVAL_STATUSES)[number];

export const GEO_PUBLICATION_SCOPES = ["PUBLIC", "INTERNAL", "CONFIDENTIAL"] as const;
export type GeoPublicationScope = (typeof GEO_PUBLICATION_SCOPES)[number];

export const GEO_RISK_LEVELS = ["HIGH", "NORMAL"] as const;
export type GeoRiskLevel = (typeof GEO_RISK_LEVELS)[number];

export const GEO_ASSERTION_STATUSES = [
	"DISCOVERED",
	"PARSED",
	"PENDING_REVIEW",
	"APPROVED",
	"REJECTED",
	"NEEDS_EVIDENCE",
	"SUPERSEDED",
	"SOURCE_UNAVAILABLE",
] as const;
export type GeoAssertionStatus = (typeof GEO_ASSERTION_STATUSES)[number];

export const GEO_ASSERTION_SOURCE_KINDS = ["PAGE_VERSION", "ASSET"] as const;
export type GeoAssertionSourceKind = (typeof GEO_ASSERTION_SOURCE_KINDS)[number];

export const GEO_ASSERTION_REVIEW_DECISIONS = [
	"APPROVE",
	"REJECT",
	"REQUEST_EVIDENCE",
	"INVALIDATE",
	"FREEZE",
	"UNFREEZE",
] as const;
export type GeoAssertionReviewDecision = (typeof GEO_ASSERTION_REVIEW_DECISIONS)[number];

export const GEO_CONFLICT_STATUSES = ["OPEN", "RESOLVED"] as const;
export type GeoConflictStatus = (typeof GEO_CONFLICT_STATUSES)[number];

export const GEO_CONFLICT_RESOLUTIONS = ["KEEP_APPROVED", "ACCEPT_CANDIDATE", "SUPERSEDED"] as const;
export type GeoConflictResolution = (typeof GEO_CONFLICT_RESOLUTIONS)[number];

export const GEO_TASK_STATES = [
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
] as const;
export type GeoTaskState = (typeof GEO_TASK_STATES)[number];

export const GEO_TASK_KINDS = [
	"SELECTION_GUIDE",
	"CASE_ADDITION",
	"FAQ",
	"COMPANY_INTRO",
	"SITE_REVISION",
	"FACT_CORRECTION",
	"OTHER",
] as const;
export type GeoTaskKind = (typeof GEO_TASK_KINDS)[number];

export const GEO_TASK_SOURCE_KINDS = ["OBSERVATION", "FINDING", "ASSERTION", "MANUAL"] as const;
export type GeoTaskSourceKind = (typeof GEO_TASK_SOURCE_KINDS)[number];

export const GEO_CONTENT_KINDS = ["FAQ", "SELECTION_GUIDE", "CASE", "COMPANY_INTRO"] as const;
export type GeoContentKind = (typeof GEO_CONTENT_KINDS)[number];

export const GEO_CONTENT_APPROVAL_STATES = [
	"DRAFT",
	"PENDING_TECH_REVIEW",
	"PENDING_MARKETING_REVIEW",
	"APPROVED",
	"REJECTED",
	"PUBLISHED",
] as const;
export type GeoContentApprovalState = (typeof GEO_CONTENT_APPROVAL_STATES)[number];

export const GEO_CONTENT_ACTIONS = [
	"SUBMIT",
	"APPROVE_TECH",
	"APPROVE_MARKETING",
	"REJECT",
	"REVISE",
	"PUBLISH",
] as const;
export type GeoContentAction = (typeof GEO_CONTENT_ACTIONS)[number];

export const GEO_CONTENT_GENERATORS = ["LLM", "MANUAL"] as const;
export type GeoContentGenerator = (typeof GEO_CONTENT_GENERATORS)[number];

export const GEO_REPORT_STATUSES = ["QUEUED", "RUNNING", "SUCCEEDED", "FAILED"] as const;
export type GeoReportStatus = (typeof GEO_REPORT_STATUSES)[number];

export const GEO_ALERT_SEVERITIES = ["CRITICAL", "WARNING", "INFO"] as const;
export type GeoAlertSeverity = (typeof GEO_ALERT_SEVERITIES)[number];

export const GEO_ALERT_STATUSES = ["OPEN", "ACK", "RESOLVED"] as const;
export type GeoAlertStatus = (typeof GEO_ALERT_STATUSES)[number];

export const GEO_DEFAULT_BUYER_ROLES = [
	{ code: "OWNER_PROJECT_MANAGER", title: "业主方项目经理", priority: 1 },
	{ code: "DESIGN_ELECTRICAL_ENGINEER", title: "设计院电气工程师", priority: 2 },
	{ code: "PROCUREMENT_LEAD", title: "采购负责人", priority: 3 },
	{ code: "EPC_ELECTRICAL_ENGINEER", title: "总包电气工程师", priority: 4 },
	{ code: "OPERATIONS_SUPERVISOR", title: "运维主管", priority: 5 },
	{ code: "FINANCE_COST_LEAD", title: "财务/成本负责人", priority: 6 },
] as const;

export const GEO_ADMIN_REQUEST_KINDS = ["LLM_USE_APPROVAL", "RETENTION_CHANGE", "ADMIN_MFA_POLICY"] as const;
export type GeoAdminRequestKind = (typeof GEO_ADMIN_REQUEST_KINDS)[number];

export const GEO_ADMIN_REQUEST_STATUSES = ["PENDING", "APPROVED", "REJECTED", "CANCELLED", "EXPIRED"] as const;
export type GeoAdminRequestStatus = (typeof GEO_ADMIN_REQUEST_STATUSES)[number];

export const GEO_BACKUP_KINDS = ["DAILY", "PRE_MIGRATION", "RESTORE_DRILL"] as const;
export type GeoBackupKind = (typeof GEO_BACKUP_KINDS)[number];

export const GEO_BACKUP_STATUSES = ["SUCCEEDED", "FAILED"] as const;
export type GeoBackupStatus = (typeof GEO_BACKUP_STATUSES)[number];
