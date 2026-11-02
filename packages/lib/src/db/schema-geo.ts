import {
	GEO_ACTIVE_STATUSES,
	GEO_ACTOR_KINDS,
	GEO_ADMIN_REQUEST_KINDS,
	GEO_ADMIN_REQUEST_STATUSES,
	GEO_ALERT_SEVERITIES,
	GEO_ALERT_STATUSES,
	GEO_ASSERTION_REVIEW_DECISIONS,
	GEO_ASSERTION_SOURCE_KINDS,
	GEO_ASSERTION_STATUSES,
	GEO_ASSET_APPROVAL_STATUSES,
	GEO_ASSET_TYPES,
	GEO_ATTEMPT_STATUSES,
	GEO_BACKUP_KINDS,
	GEO_BACKUP_STATUSES,
	GEO_BATCH_STATUSES,
	GEO_BRAND_KINDS,
	GEO_BREAKER_STATES,
	GEO_CLAIM_KINDS,
	GEO_CLAIM_MATCH_STATUSES,
	GEO_CLAIM_VERDICTS,
	GEO_CONFLICT_STATUSES,
	GEO_CONTENT_ACTIONS,
	GEO_CONTENT_APPROVAL_STATES,
	GEO_CONTENT_KINDS,
	GEO_CRAWL_ITEM_OUTCOMES,
	GEO_CRAWL_ITEM_SOURCES,
	GEO_CRAWL_ITEM_STATUSES,
	GEO_CRAWL_MODES,
	GEO_CRAWL_STATUSES,
	GEO_EVALUATION_REVIEW_STATUSES,
	GEO_FACT_STATUSES,
	GEO_FINDING_SEVERITIES,
	GEO_FINDING_STATUSES,
	GEO_OBSERVATION_STATUSES,
	GEO_PARSE_STATUSES,
	GEO_PLATFORMS,
	GEO_PRIORITIES,
	GEO_PROMPT_SET_STATUSES,
	GEO_PROMPT_STATUSES,
	GEO_PROMPT_TIERS,
	GEO_PUBLICATION_SCOPES,
	GEO_RECOMMENDATIONS,
	GEO_REPORT_REVIEW_STATUSES,
	GEO_REPORT_STATUSES,
	GEO_RETRY_RELATIONS,
	GEO_REVIEW_REASONS,
	GEO_RISK_LEVELS,
	GEO_ROLES,
	GEO_RUN_STATUSES,
	GEO_SCAN_STATUSES,
	GEO_SITE_AUDIT_RUN_STATUSES,
	GEO_SITE_ENTITY_KINDS,
	GEO_SITE_ENTITY_STATUSES,
	GEO_SITE_PAGE_STATUSES,
	GEO_SITE_QA_SAMPLE_STATUSES,
	GEO_SITE_QA_VERDICTS,
	GEO_SURFACE_MODES,
	GEO_TASK_KINDS,
	GEO_TASK_SOURCE_KINDS,
	GEO_TASK_STATES,
	GEO_TERM_KINDS,
	GEO_VERIFICATION_STATUSES,
	type GeoActiveStatus,
	type GeoActorKind,
	type GeoAdminRequestKind,
	type GeoAdminRequestStatus,
	type GeoAlertSeverity,
	type GeoAlertStatus,
	type GeoAssertionReviewDecision,
	type GeoAssertionSourceKind,
	type GeoAssertionStatus,
	type GeoAssetApprovalStatus,
	type GeoAssetType,
	type GeoAttemptStatus,
	type GeoBackupKind,
	type GeoBackupStatus,
	type GeoBatchStatus,
	type GeoBrandKind,
	type GeoBreakerState,
	type GeoCitationAttribution,
	type GeoClaimKind,
	type GeoClaimMatchStatus,
	type GeoClaimVerdict,
	type GeoCompetitorHit,
	type GeoConflictStatus,
	type GeoContentAction,
	type GeoContentApprovalState,
	type GeoContentKind,
	type GeoCrawlItemOutcome,
	type GeoCrawlItemSource,
	type GeoCrawlItemStatus,
	type GeoCrawlMode,
	type GeoCrawlStatus,
	type GeoDictionaryEntityChange,
	type GeoDictionarySnapshot,
	type GeoEvaluationReviewStatus,
	type GeoEvaluationSignals,
	type GeoEvidenceSpan,
	type GeoFactStatus,
	type GeoFindingSeverity,
	type GeoFindingStatus,
	type GeoObservationStatus,
	type GeoParseStatus,
	type GeoPlatform,
	type GeoPriority,
	type GeoPromptLabels,
	type GeoPromptRevisionSnapshot,
	type GeoPromptSetStatus,
	type GeoPromptStatus,
	type GeoPromptTier,
	type GeoPublicationScope,
	type GeoRecommendation,
	type GeoReportReviewStatus,
	type GeoReportStatus,
	type GeoRetryRelation,
	type GeoReviewReason,
	type GeoRiskLevel,
	type GeoRole,
	type GeoRunStatus,
	type GeoScanStatus,
	type GeoSiteAuditRunStatus,
	type GeoSiteEntityKind,
	type GeoSiteEntityStatus,
	type GeoSitePageStatus,
	type GeoSiteQaSampleStatus,
	type GeoSiteQaVerdict,
	type GeoSurfaceMode,
	type GeoTaskKind,
	type GeoTaskSourceKind,
	type GeoTaskState,
	type GeoTermKind,
	type GeoVerificationStatus,
} from "@workspace/geo-domain";
import { type SQL, sql } from "drizzle-orm";
import {
	type AnyPgColumn,
	bigint,
	boolean,
	check,
	doublePrecision,
	foreignKey,
	index,
	integer,
	jsonb,
	numeric,
	pgTable,
	primaryKey,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
import { organization, user } from "./schema-auth";

// Actor columns stay plain text with no FK to `user`: an actor can be an API key or
// the system, and a foreign key would make removing a person rewrite immutable rows.

const pk = () => uuid("id").defaultRandom().primaryKey().notNull();
const org = () =>
	text("organization_id")
		.notNull()
		.references(() => organization.id);
const at = (name: string) => timestamp(name, { withTimezone: true });
const createdAt = () => at("created_at").defaultNow().notNull();
const updatedAt = () =>
	at("updated_at")
		.defaultNow()
		.$onUpdate(() => new Date())
		.notNull();

function oneOf(name: string, column: AnyPgColumn, values: readonly string[]) {
	const list = values.map((value) => `'${value}'`).join(", ");
	return check(name, sql`${column} in (${sql.raw(list)})`);
}

function nullOrOneOf(name: string, column: AnyPgColumn, values: readonly string[]) {
	const list = values.map((value) => `'${value}'`).join(", ");
	return check(name, sql`${column} is null or ${column} in (${sql.raw(list)})`);
}

function exactlyOne(...columns: AnyPgColumn[]): SQL {
	const clauses = columns.map((column) => sql`(${column} is not null)::int`);
	return sql`${sql.join(clauses, sql` + `)} = 1`;
}

// ---------------------------------------------------------------------------
// Identity and configuration
// ---------------------------------------------------------------------------

export const geoRoleAssignments = pgTable(
	"geo_role_assignments",
	{
		id: pk(),
		organizationId: org(),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		role: text("role").$type<GeoRole>().notNull(),
		grantedBy: text("granted_by").notNull(),
		createdAt: createdAt(),
	},
	(table) => [
		uniqueIndex("geo_role_assignments_org_user_role_idx").on(table.organizationId, table.userId, table.role),
		index("geo_role_assignments_user_idx").on(table.userId),
		oneOf("geo_role_assignments_role_check", table.role, GEO_ROLES),
	],
).enableRLS();

export const geoOrgSettings = pgTable("geo_org_settings", {
	organizationId: text("organization_id")
		.primaryKey()
		.notNull()
		.references(() => organization.id),
	llmUseApproved: boolean("llm_use_approved").notNull().default(false),
	approvedBy: text("approved_by"),
	approvedAt: at("approved_at"),
	samplingDailyLimit: integer("sampling_daily_limit"),
	samplingBatchLimit: integer("sampling_batch_limit"),
	samplingCostBudget: numeric("sampling_cost_budget", { precision: 12, scale: 4 }),
	evidenceRetentionDays: integer("evidence_retention_days"),
	snapshotRetentionDays: integer("snapshot_retention_days"),
	auditRetentionDays: integer("audit_retention_days"),
	alertRecipients: text("alert_recipients").array().notNull().default([]),
	adminMfaRequired: boolean("admin_mfa_required").notNull().default(true),
	updatedBy: text("updated_by"),
	createdAt: createdAt(),
	updatedAt: updatedAt(),
}).enableRLS();

export const geoBrandEntities = pgTable(
	"geo_brand_entities",
	{
		id: pk(),
		organizationId: org(),
		kind: text("kind").$type<GeoBrandKind>().notNull(),
		displayName: text("display_name").notNull(),
		legalName: text("legal_name"),
		shortName: text("short_name"),
		aliases: text("aliases").array().notNull().default([]),
		historicalNames: text("historical_names").array().notNull().default([]),
		domains: text("domains").array().notNull().default([]),
		officialUrl: text("official_url"),
		regions: text("regions").array().notNull().default([]),
		status: text("status").$type<GeoActiveStatus>().notNull().default("ACTIVE"),
		factStatus: text("fact_status").$type<GeoFactStatus>().notNull().default("UNVERIFIED"),
		factNotes: text("fact_notes").array().notNull().default([]),
		createdBy: text("created_by").notNull(),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(table) => [
		uniqueIndex("geo_brand_entities_org_name_idx").on(table.organizationId, table.displayName),
		index("geo_brand_entities_org_kind_idx").on(table.organizationId, table.kind),
		oneOf("geo_brand_entities_kind_check", table.kind, GEO_BRAND_KINDS),
		oneOf("geo_brand_entities_status_check", table.status, GEO_ACTIVE_STATUSES),
		oneOf("geo_brand_entities_fact_status_check", table.factStatus, GEO_FACT_STATUSES),
	],
).enableRLS();

export const geoDictionaryVersions = pgTable(
	"geo_dictionary_versions",
	{
		id: pk(),
		organizationId: org(),
		version: integer("version").notNull(),
		snapshot: jsonb("snapshot").$type<GeoDictionarySnapshot>().notNull(),
		changes: jsonb("changes").$type<GeoDictionaryEntityChange[]>().notNull().default([]),
		changedEntityIds: uuid("changed_entity_ids").array().notNull().default([]),
		changeNote: text("change_note"),
		createdBy: text("created_by").notNull(),
		createdAt: createdAt(),
	},
	(table) => [uniqueIndex("geo_dictionary_versions_org_version_idx").on(table.organizationId, table.version)],
).enableRLS();

export const geoProducts = pgTable(
	"geo_products",
	{
		id: pk(),
		organizationId: org(),
		brandEntityId: uuid("brand_entity_id")
			.notNull()
			.references(() => geoBrandEntities.id),
		model: text("model"),
		name: text("name").notNull(),
		category: text("category"),
		termKind: text("term_kind").$type<GeoTermKind>().notNull(),
		factStatus: text("fact_status").$type<GeoFactStatus>().notNull().default("UNVERIFIED"),
		status: text("status").$type<GeoActiveStatus>().notNull().default("ACTIVE"),
		createdBy: text("created_by").notNull(),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(table) => [
		uniqueIndex("geo_products_org_brand_name_model_idx").on(
			table.organizationId,
			table.brandEntityId,
			table.name,
			table.model,
		),
		index("geo_products_brand_idx").on(table.brandEntityId),
		oneOf("geo_products_term_kind_check", table.termKind, GEO_TERM_KINDS),
		oneOf("geo_products_fact_status_check", table.factStatus, GEO_FACT_STATUSES),
		oneOf("geo_products_status_check", table.status, GEO_ACTIVE_STATUSES),
	],
).enableRLS();

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

export const geoBuyerRoles = pgTable(
	"geo_buyer_roles",
	{
		id: pk(),
		organizationId: org(),
		code: text("code").notNull(),
		title: text("title").notNull(),
		priority: integer("priority").notNull().default(0),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(table) => [uniqueIndex("geo_buyer_roles_org_code_idx").on(table.organizationId, table.code)],
).enableRLS();

export const geoPrompts = pgTable(
	"geo_prompts",
	{
		id: pk(),
		organizationId: org(),
		question: text("question").notNull(),
		buyerRoleId: uuid("buyer_role_id").references(() => geoBuyerRoles.id),
		intent: text("intent"),
		productLine: text("product_line"),
		geoRegion: text("geo_region"),
		priority: text("priority").$type<GeoPriority>().notNull().default("P2"),
		language: text("language").notNull().default("zh-CN"),
		tier: text("tier").$type<GeoPromptTier>().notNull().default("CORE"),
		status: text("status").$type<GeoPromptStatus>().notNull().default("DRAFT"),
		ownerId: text("owner_id"),
		reviewerId: text("reviewer_id"),
		reviewNote: text("review_note"),
		sourceNote: text("source_note"),
		currentRevision: integer("current_revision").notNull().default(1),
		createdBy: text("created_by").notNull(),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(table) => [
		index("geo_prompts_org_status_idx").on(table.organizationId, table.status),
		index("geo_prompts_org_role_idx").on(table.organizationId, table.buyerRoleId),
		oneOf("geo_prompts_priority_check", table.priority, GEO_PRIORITIES),
		oneOf("geo_prompts_tier_check", table.tier, GEO_PROMPT_TIERS),
		oneOf("geo_prompts_status_check", table.status, GEO_PROMPT_STATUSES),
	],
).enableRLS();

export const geoPromptRevisions = pgTable(
	"geo_prompt_revisions",
	{
		organizationId: org(),
		promptId: uuid("prompt_id")
			.notNull()
			.references(() => geoPrompts.id),
		revision: integer("revision").notNull(),
		snapshot: jsonb("snapshot").$type<GeoPromptRevisionSnapshot>().notNull(),
		editorId: text("editor_id").notNull(),
		createdAt: createdAt(),
	},
	(table) => [primaryKey({ columns: [table.promptId, table.revision] })],
).enableRLS();

export const geoPromptSets = pgTable(
	"geo_prompt_sets",
	{
		id: pk(),
		organizationId: org(),
		name: text("name").notNull(),
		version: integer("version").notNull().default(1),
		status: text("status").$type<GeoPromptSetStatus>().notNull().default("DRAFT"),
		parentSetId: uuid("parent_set_id").references((): AnyPgColumn => geoPromptSets.id),
		frozenAt: at("frozen_at"),
		frozenBy: text("frozen_by"),
		createdBy: text("created_by").notNull(),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(table) => [
		uniqueIndex("geo_prompt_sets_org_name_version_idx").on(table.organizationId, table.name, table.version),
		oneOf("geo_prompt_sets_status_check", table.status, GEO_PROMPT_SET_STATUSES),
	],
).enableRLS();

export const geoPromptSetItems = pgTable(
	"geo_prompt_set_items",
	{
		organizationId: org(),
		setId: uuid("set_id")
			.notNull()
			.references(() => geoPromptSets.id),
		promptId: uuid("prompt_id")
			.notNull()
			.references(() => geoPrompts.id),
		promptRevision: integer("prompt_revision").notNull(),
		questionText: text("question_text").notNull(),
		labels: jsonb("labels")
			.$type<GeoPromptLabels>()
			.notNull()
			.default({} as GeoPromptLabels),
		createdAt: createdAt(),
	},
	(table) => [
		primaryKey({ columns: [table.setId, table.promptId] }),
		index("geo_prompt_set_items_prompt_idx").on(table.promptId),
	],
).enableRLS();

// ---------------------------------------------------------------------------
// Sampling and evidence
// ---------------------------------------------------------------------------

export const geoSamplingTargets = pgTable(
	"geo_sampling_targets",
	{
		id: pk(),
		organizationId: org(),
		platform: text("platform").$type<GeoPlatform>().notNull(),
		surfaceMode: text("surface_mode").$type<GeoSurfaceMode>().notNull(),
		provider: text("provider").notNull(),
		modelId: text("model_id"),
		region: text("region"),
		language: text("language").notNull().default("zh-CN"),
		config: jsonb("config").notNull().default({}),
		/** A pointer into the encrypted secrets store, never the credential itself. */
		credentialRef: text("credential_ref"),
		availableWindow: jsonb("available_window"),
		maxConcurrency: integer("max_concurrency").notNull().default(1),
		perMinuteQuota: integer("per_minute_quota"),
		perDayQuota: integer("per_day_quota"),
		retryPolicy: jsonb("retry_policy"),
		costBudget: numeric("cost_budget", { precision: 12, scale: 4 }),
		breakerState: text("breaker_state").$type<GeoBreakerState>().notNull().default("CLOSED"),
		breakerFailureCount: integer("breaker_failure_count").notNull().default(0),
		breakerOpenedAt: at("breaker_opened_at"),
		verificationStatus: text("verification_status").$type<GeoVerificationStatus>().notNull().default("UNVERIFIED"),
		verificationNote: text("verification_note"),
		verifiedBy: text("verified_by"),
		verifiedAt: at("verified_at"),
		enabled: boolean("enabled").notNull().default(false),
		/** Identity of a target created from the bootstrap file, so re-applying it never duplicates. */
		bootstrapKey: text("bootstrap_key"),
		createdBy: text("created_by").notNull(),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(table) => [
		index("geo_sampling_targets_org_platform_idx").on(table.organizationId, table.platform, table.surfaceMode),
		uniqueIndex("geo_sampling_targets_org_bootstrap_key_idx").on(table.organizationId, table.bootstrapKey),
		oneOf("geo_sampling_targets_platform_check", table.platform, GEO_PLATFORMS),
		oneOf("geo_sampling_targets_surface_mode_check", table.surfaceMode, GEO_SURFACE_MODES),
		oneOf("geo_sampling_targets_breaker_check", table.breakerState, GEO_BREAKER_STATES),
		oneOf("geo_sampling_targets_verification_check", table.verificationStatus, GEO_VERIFICATION_STATUSES),
	],
).enableRLS();

export const geoSamplingBatches = pgTable(
	"geo_sampling_batches",
	{
		id: pk(),
		organizationId: org(),
		promptSetId: uuid("prompt_set_id")
			.notNull()
			.references(() => geoPromptSets.id),
		repeatCount: integer("repeat_count").notNull().default(3),
		/** Extended questions are sampled only when someone asks for them; the batch records that they did. */
		includesExtended: boolean("includes_extended").notNull().default(false),
		status: text("status").$type<GeoBatchStatus>().notNull().default("PLANNED"),
		plannedCount: integer("planned_count").notNull().default(0),
		validCount: integer("valid_count").notNull().default(0),
		partialCount: integer("partial_count").notNull().default(0),
		unavailableCount: integer("unavailable_count").notNull().default(0),
		failedCount: integer("failed_count").notNull().default(0),
		costEstimate: numeric("cost_estimate", { precision: 12, scale: 4 }),
		requestedBy: text("requested_by").notNull(),
		idempotencyKey: text("idempotency_key").notNull(),
		startedAt: at("started_at"),
		finishedAt: at("finished_at"),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(table) => [
		uniqueIndex("geo_sampling_batches_org_key_idx").on(table.organizationId, table.idempotencyKey),
		index("geo_sampling_batches_org_status_idx").on(table.organizationId, table.status),
		index("geo_sampling_batches_set_idx").on(table.promptSetId),
		oneOf("geo_sampling_batches_status_check", table.status, GEO_BATCH_STATUSES),
	],
).enableRLS();

export const geoSamplingRuns = pgTable(
	"geo_sampling_runs",
	{
		id: pk(),
		organizationId: org(),
		batchId: uuid("batch_id")
			.notNull()
			.references(() => geoSamplingBatches.id),
		promptId: uuid("prompt_id")
			.notNull()
			.references(() => geoPrompts.id),
		targetId: uuid("target_id")
			.notNull()
			.references(() => geoSamplingTargets.id),
		repeatIndex: integer("repeat_index").notNull(),
		idempotencyKey: text("idempotency_key").notNull(),
		status: text("status").$type<GeoRunStatus>().notNull().default("PLANNED"),
		retryOfRunId: uuid("retry_of_run_id").references((): AnyPgColumn => geoSamplingRuns.id),
		retryRelation: text("retry_relation").$type<GeoRetryRelation>(),
		errorCode: text("error_code"),
		errorDetail: text("error_detail"),
		attemptCount: integer("attempt_count").notNull().default(0),
		/** When a PLANNED run is next due; the sweep only re-queues runs past it, so backoff survives a lost job. */
		nextAttemptAt: at("next_attempt_at"),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(table) => [
		uniqueIndex("geo_sampling_runs_idempotency_key_idx").on(table.idempotencyKey),
		index("geo_sampling_runs_status_due_idx").on(table.status, table.nextAttemptAt),
		index("geo_sampling_runs_batch_status_idx").on(table.batchId, table.status),
		index("geo_sampling_runs_org_status_idx").on(table.organizationId, table.status),
		index("geo_sampling_runs_target_idx").on(table.targetId),
		oneOf("geo_sampling_runs_status_check", table.status, GEO_RUN_STATUSES),
		nullOrOneOf("geo_sampling_runs_retry_relation_check", table.retryRelation, GEO_RETRY_RELATIONS),
	],
).enableRLS();

export const geoSamplingAttempts = pgTable(
	"geo_sampling_attempts",
	{
		id: pk(),
		organizationId: org(),
		runId: uuid("run_id")
			.notNull()
			.references(() => geoSamplingRuns.id),
		/** Copied from the run so quota, concurrency and cost checks per target need no join. */
		targetId: uuid("target_id")
			.notNull()
			.references(() => geoSamplingTargets.id),
		attemptNo: integer("attempt_no").notNull(),
		startedAt: at("started_at").notNull(),
		durationMs: integer("duration_ms"),
		status: text("status").$type<GeoAttemptStatus>().notNull(),
		errorCode: text("error_code"),
		costEstimate: numeric("cost_estimate", { precision: 12, scale: 4 }),
		providerTraceId: text("provider_trace_id"),
	},
	(table) => [
		uniqueIndex("geo_sampling_attempts_run_attempt_idx").on(table.runId, table.attemptNo),
		index("geo_sampling_attempts_target_started_idx").on(table.targetId, table.startedAt),
		oneOf("geo_sampling_attempts_status_check", table.status, GEO_ATTEMPT_STATUSES),
	],
).enableRLS();

/** Append-only, enforced by a trigger: a correction is a new evaluation, never an edit here. */
export const geoObservations = pgTable(
	"geo_observations",
	{
		id: pk(),
		organizationId: org(),
		/** Null only for manually imported evidence, which no run produced. */
		runId: uuid("run_id").references(() => geoSamplingRuns.id),
		promptId: uuid("prompt_id")
			.notNull()
			.references(() => geoPrompts.id),
		promptSetId: uuid("prompt_set_id").references(() => geoPromptSets.id),
		promptRevision: integer("prompt_revision").notNull(),
		questionText: text("question_text").notNull(),
		targetId: uuid("target_id")
			.notNull()
			.references(() => geoSamplingTargets.id),
		platform: text("platform").$type<GeoPlatform>().notNull(),
		surfaceMode: text("surface_mode").$type<GeoSurfaceMode>().notNull(),
		status: text("status").$type<GeoObservationStatus>().notNull(),
		responseText: text("response_text"),
		sampledAt: at("sampled_at").notNull(),
		responseMetadata: jsonb("response_metadata"),
		providerVersion: text("provider_version"),
		modelVersion: text("model_version"),
		sourceMethodVersion: text("source_method_version"),
		evidenceUri: text("evidence_uri"),
		errorCode: text("error_code"),
		retryOfObservationId: uuid("retry_of_observation_id").references((): AnyPgColumn => geoObservations.id),
		importBatchId: uuid("import_batch_id"),
		importedBy: text("imported_by"),
		createdAt: createdAt(),
	},
	(table) => [
		uniqueIndex("geo_observations_run_idx").on(table.runId),
		index("geo_observations_org_sampled_idx").on(table.organizationId, table.sampledAt),
		index("geo_observations_org_prompt_target_idx").on(
			table.organizationId,
			table.promptId,
			table.targetId,
			table.sampledAt,
		),
		index("geo_observations_org_set_idx").on(table.organizationId, table.promptSetId),
		index("geo_observations_org_status_idx").on(table.organizationId, table.status),
		oneOf("geo_observations_platform_check", table.platform, GEO_PLATFORMS),
		oneOf("geo_observations_surface_mode_check", table.surfaceMode, GEO_SURFACE_MODES),
		oneOf("geo_observations_status_check", table.status, GEO_OBSERVATION_STATUSES),
	],
).enableRLS();

/**
 * Who uploaded which evidence file, and which import used it. A manual import may only
 * point at an upload of its own, so an observation can never be aimed at another object.
 */
export const geoEvidenceUploads = pgTable(
	"geo_evidence_uploads",
	{
		id: pk(),
		organizationId: org(),
		objectKey: text("object_key").notNull(),
		sha256: text("sha256").notNull(),
		contentType: text("content_type").notNull(),
		sizeBytes: integer("size_bytes").notNull(),
		uploadedBy: text("uploaded_by").notNull(),
		importBatchId: uuid("import_batch_id"),
		createdAt: createdAt(),
	},
	(table) => [
		index("geo_evidence_uploads_org_key_idx").on(table.organizationId, table.objectKey),
		index("geo_evidence_uploads_org_pending_idx")
			.on(table.organizationId, table.createdAt)
			.where(sql`import_batch_id is null`),
	],
).enableRLS();

export const geoObservationCitations = pgTable(
	"geo_observation_citations",
	{
		id: pk(),
		organizationId: org(),
		observationId: uuid("observation_id")
			.notNull()
			.references(() => geoObservations.id),
		ordinal: integer("ordinal").notNull(),
		url: text("url").notNull(),
		normalizedUrl: text("normalized_url"),
		host: text("host"),
		title: text("title"),
		sourceType: text("source_type"),
		createdAt: createdAt(),
	},
	(table) => [
		uniqueIndex("geo_observation_citations_observation_ordinal_idx").on(table.observationId, table.ordinal),
		index("geo_observation_citations_org_host_idx").on(table.organizationId, table.host),
	],
).enableRLS();

/** Rows are only ever added, apart from `is_current`, which points at the latest of them. */
export const geoEvaluations = pgTable(
	"geo_evaluations",
	{
		id: pk(),
		organizationId: org(),
		observationId: uuid("observation_id")
			.notNull()
			.references(() => geoObservations.id),
		version: integer("version").notNull(),
		evaluatorVersion: text("evaluator_version").notNull(),
		dictionaryVersionId: uuid("dictionary_version_id"),
		brandMentioned: boolean("brand_mentioned").notNull(),
		recommendation: text("recommendation").$type<GeoRecommendation>().notNull(),
		hasOrderedList: boolean("has_ordered_list").notNull().default(false),
		brandRank: integer("brand_rank"),
		competitorHits: jsonb("competitor_hits").$type<GeoCompetitorHit[]>().notNull().default([]),
		evidenceSpans: jsonb("evidence_spans").$type<GeoEvidenceSpan[]>().notNull().default([]),
		citationAttribution: jsonb("citation_attribution").$type<GeoCitationAttribution[]>().notNull().default([]),
		signals: jsonb("signals").$type<GeoEvaluationSignals>(),
		confidence: doublePrecision("confidence"),
		reviewStatus: text("review_status").$type<GeoEvaluationReviewStatus>().notNull(),
		reviewReasons: text("review_reasons").array().$type<GeoReviewReason[]>().notNull().default([]),
		/** Higher is reviewed first; set when the evaluation enters the review pool. */
		reviewPriority: integer("review_priority").notNull().default(0),
		isCurrent: boolean("is_current").notNull().default(true),
		supersedesId: uuid("supersedes_id").references((): AnyPgColumn => geoEvaluations.id),
		createdBy: text("created_by").notNull(),
		reason: text("reason"),
		createdAt: createdAt(),
	},
	(table) => [
		foreignKey({
			name: "geo_evaluations_dictionary_version_fk",
			columns: [table.dictionaryVersionId],
			foreignColumns: [geoDictionaryVersions.id],
		}),
		uniqueIndex("geo_evaluations_observation_version_idx").on(table.observationId, table.version),
		uniqueIndex("geo_evaluations_observation_current_idx")
			.on(table.observationId)
			.where(sql`${table.isCurrent} = true`),
		index("geo_evaluations_org_review_idx").on(table.organizationId, table.reviewStatus),
		index("geo_evaluations_review_pool_idx")
			.on(table.organizationId, table.reviewPriority, table.createdAt)
			.where(sql`${table.isCurrent} = true and ${table.reviewStatus} = 'PENDING_REVIEW'`),
		check(
			"geo_evaluations_review_reasons_check",
			sql`${table.reviewReasons} <@ array[${sql.raw(GEO_REVIEW_REASONS.map((reason) => `'${reason}'`).join(", "))}]::text[]`,
		),
		oneOf("geo_evaluations_recommendation_check", table.recommendation, GEO_RECOMMENDATIONS),
		oneOf("geo_evaluations_review_status_check", table.reviewStatus, GEO_EVALUATION_REVIEW_STATUSES),
	],
).enableRLS();

export const geoObservationClaims = pgTable(
	"geo_observation_claims",
	{
		id: pk(),
		organizationId: org(),
		observationId: uuid("observation_id")
			.notNull()
			.references(() => geoObservations.id),
		evaluationId: uuid("evaluation_id").references(() => geoEvaluations.id),
		claimText: text("claim_text").notNull(),
		span: jsonb("span").$type<{ start: number; end: number }>(),
		claimKind: text("claim_kind").$type<GeoClaimKind>().notNull().default("NUMBER"),
		/** The value as the answer states it, normalised for comparison (for example "12kv"). */
		extractedValue: text("extracted_value"),
		/** The approved value it was compared with, when one was found. */
		referenceValue: text("reference_value"),
		matchStatus: text("match_status").$type<GeoClaimMatchStatus>().notNull().default("NO_REFERENCE"),
		assertionId: uuid("assertion_id"),
		verdict: text("verdict").$type<GeoClaimVerdict>().notNull().default("UNVERIFIED"),
		reviewerId: text("reviewer_id"),
		reviewedAt: at("reviewed_at"),
		reviewNote: text("review_note"),
		createdAt: createdAt(),
	},
	(table) => [
		foreignKey({
			name: "geo_observation_claims_assertion_fk",
			columns: [table.assertionId],
			foreignColumns: [geoKnowledgeAssertions.id],
		}),
		index("geo_observation_claims_observation_idx").on(table.observationId),
		index("geo_observation_claims_org_verdict_idx").on(table.organizationId, table.verdict),
		oneOf("geo_observation_claims_verdict_check", table.verdict, GEO_CLAIM_VERDICTS),
		oneOf("geo_observation_claims_kind_check", table.claimKind, GEO_CLAIM_KINDS),
		oneOf("geo_observation_claims_match_check", table.matchStatus, GEO_CLAIM_MATCH_STATUSES),
	],
).enableRLS();

// ---------------------------------------------------------------------------
// Site ingestion
// ---------------------------------------------------------------------------

export const geoSiteSources = pgTable(
	"geo_site_sources",
	{
		id: pk(),
		organizationId: org(),
		baseUrl: text("base_url").notNull(),
		allowedHosts: text("allowed_hosts").array().notNull(),
		scope: jsonb("scope"),
		seedUrls: text("seed_urls").array().notNull().default([]),
		profile: jsonb("profile").notNull().default({}),
		policyVersion: text("policy_version").notNull(),
		requestsPerSecond: doublePrecision("requests_per_second").notNull().default(1),
		concurrency: integer("concurrency").notNull().default(1),
		maxPages: integer("max_pages"),
		maxAssetBytes: bigint("max_asset_bytes", { mode: "number" }),
		opWindow: jsonb("op_window"),
		crawlCron: text("crawl_cron"),
		userAgentContact: text("user_agent_contact"),
		/** The pages the customer confirmed must be found; coverage is measured against them. */
		keyUrls: text("key_urls").array().notNull().default([]),
		enabled: boolean("enabled").notNull().default(true),
		lastSuccessAt: at("last_success_at"),
		authorizationNote: text("authorization_note"),
		createdBy: text("created_by").notNull(),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(table) => [uniqueIndex("geo_site_sources_org_base_url_idx").on(table.organizationId, table.baseUrl)],
).enableRLS();

export const geoSiteCrawlRuns = pgTable(
	"geo_site_crawl_runs",
	{
		id: pk(),
		organizationId: org(),
		siteSourceId: uuid("site_source_id")
			.notNull()
			.references(() => geoSiteSources.id),
		mode: text("mode").$type<GeoCrawlMode>().notNull(),
		status: text("status").$type<GeoCrawlStatus>().notNull().default("QUEUED"),
		counts: jsonb("counts").notNull().default({}),
		policyVersion: text("policy_version").notNull(),
		/** What this run was asked to do: seed override, link following, page budget. */
		config: jsonb("config").notNull().default({}),
		idempotencyKey: text("idempotency_key").notNull(),
		startedAt: at("started_at"),
		finishedAt: at("finished_at"),
		requestedBy: text("requested_by").notNull(),
		errorSummary: text("error_summary"),
		createdAt: createdAt(),
	},
	(table) => [
		uniqueIndex("geo_site_crawl_runs_org_key_idx").on(table.organizationId, table.idempotencyKey),
		index("geo_site_crawl_runs_source_created_idx").on(table.siteSourceId, table.createdAt),
		oneOf("geo_site_crawl_runs_mode_check", table.mode, GEO_CRAWL_MODES),
		oneOf("geo_site_crawl_runs_status_check", table.status, GEO_CRAWL_STATUSES),
	],
).enableRLS();

export const geoSitePages = pgTable(
	"geo_site_pages",
	{
		id: pk(),
		organizationId: org(),
		siteSourceId: uuid("site_source_id")
			.notNull()
			.references(() => geoSiteSources.id),
		normalizedUrl: text("normalized_url").notNull(),
		canonicalUrl: text("canonical_url"),
		category: text("category"),
		status: text("status").$type<GeoSitePageStatus>().notNull().default("ACTIVE"),
		httpStatus: integer("http_status"),
		lastSeenAt: at("last_seen_at"),
		lastFetchedAt: at("last_fetched_at"),
		consecutiveFailures: integer("consecutive_failures").notNull().default(0),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(table) => [
		uniqueIndex("geo_site_pages_org_source_url_idx").on(table.organizationId, table.siteSourceId, table.normalizedUrl),
		index("geo_site_pages_org_status_idx").on(table.organizationId, table.status),
		index("geo_site_pages_org_category_idx").on(table.organizationId, table.category),
		oneOf("geo_site_pages_status_check", table.status, GEO_SITE_PAGE_STATUSES),
	],
).enableRLS();

/** Append-only, enforced by a trigger. */
export const geoSitePageVersions = pgTable(
	"geo_site_page_versions",
	{
		id: pk(),
		organizationId: org(),
		pageId: uuid("page_id")
			.notNull()
			.references(() => geoSitePages.id),
		contentHash: text("content_hash").notNull(),
		parserVersion: text("parser_version").notNull(),
		htmlObjectKey: text("html_object_key").notNull(),
		parsedObjectKey: text("parsed_object_key"),
		title: text("title"),
		parsed: jsonb("parsed"),
		fetchedAt: at("fetched_at").notNull(),
		parseStatus: text("parse_status").$type<GeoParseStatus>().notNull(),
		errorCode: text("error_code"),
		createdAt: createdAt(),
	},
	(table) => [
		uniqueIndex("geo_site_page_versions_page_hash_parser_idx").on(table.pageId, table.contentHash, table.parserVersion),
		index("geo_site_page_versions_page_fetched_idx").on(table.pageId, table.fetchedAt),
		oneOf("geo_site_page_versions_parse_status_check", table.parseStatus, GEO_PARSE_STATUSES),
	],
).enableRLS();

export const geoSiteEntities = pgTable(
	"geo_site_entities",
	{
		id: pk(),
		organizationId: org(),
		kind: text("kind").$type<GeoSiteEntityKind>().notNull(),
		canonicalKey: text("canonical_key").notNull(),
		title: text("title").notNull(),
		attributes: jsonb("attributes").notNull().default({}),
		status: text("status").$type<GeoSiteEntityStatus>().notNull().default("CANDIDATE"),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(table) => [
		uniqueIndex("geo_site_entities_org_kind_key_idx").on(table.organizationId, table.kind, table.canonicalKey),
		oneOf("geo_site_entities_kind_check", table.kind, GEO_SITE_ENTITY_KINDS),
		oneOf("geo_site_entities_status_check", table.status, GEO_SITE_ENTITY_STATUSES),
	],
).enableRLS();

export const geoSiteEntitySources = pgTable(
	"geo_site_entity_sources",
	{
		id: pk(),
		organizationId: org(),
		entityId: uuid("entity_id")
			.notNull()
			.references(() => geoSiteEntities.id),
		pageVersionId: uuid("page_version_id").notNull(),
		fieldPath: text("field_path").notNull(),
		locator: jsonb("locator"),
		createdAt: createdAt(),
	},
	(table) => [
		foreignKey({
			name: "geo_site_entity_sources_page_version_fk",
			columns: [table.pageVersionId],
			foreignColumns: [geoSitePageVersions.id],
		}),
		uniqueIndex("geo_site_entity_sources_entity_version_field_idx").on(
			table.entityId,
			table.pageVersionId,
			table.fieldPath,
		),
		index("geo_site_entity_sources_version_idx").on(table.pageVersionId),
	],
).enableRLS();

/** Every profile a source has had, so a page can be re-parsed with any of them. Append-only. */
export const geoSiteProfileVersions = pgTable(
	"geo_site_profile_versions",
	{
		id: pk(),
		organizationId: org(),
		siteSourceId: uuid("site_source_id")
			.notNull()
			.references(() => geoSiteSources.id),
		version: integer("version").notNull(),
		profile: jsonb("profile").notNull(),
		createdBy: text("created_by").notNull(),
		createdAt: createdAt(),
	},
	(table) => [uniqueIndex("geo_site_profile_versions_source_version_idx").on(table.siteSourceId, table.version)],
).enableRLS();

/** The frontier of one crawl run and what each URL came to; it is also what makes a run resumable. */
export const geoSiteCrawlItems = pgTable(
	"geo_site_crawl_items",
	{
		id: pk(),
		organizationId: org(),
		runId: uuid("run_id")
			.notNull()
			.references(() => geoSiteCrawlRuns.id),
		url: text("url").notNull(),
		source: text("source").$type<GeoCrawlItemSource>().notNull(),
		depth: integer("depth").notNull().default(0),
		priority: integer("priority").notNull().default(2),
		isAsset: boolean("is_asset").notNull().default(false),
		discoveredFrom: text("discovered_from"),
		status: text("status").$type<GeoCrawlItemStatus>().notNull().default("QUEUED"),
		outcome: text("outcome").$type<GeoCrawlItemOutcome>(),
		pageId: uuid("page_id").references(() => geoSitePages.id),
		httpStatus: integer("http_status"),
		attempts: integer("attempts").notNull().default(0),
		durationMs: integer("duration_ms"),
		finalUrl: text("final_url"),
		contentHash: text("content_hash"),
		rawObjectKey: text("raw_object_key"),
		fetchedAt: at("fetched_at"),
		/** Filled by the parse job once the immutable version row exists. */
		versionId: uuid("version_id").references(() => geoSitePageVersions.id),
		detail: text("detail"),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(table) => [
		uniqueIndex("geo_site_crawl_items_run_url_idx").on(table.runId, table.url),
		index("geo_site_crawl_items_run_status_idx").on(table.runId, table.status, table.priority, table.depth),
		index("geo_site_crawl_items_pending_parse_idx")
			.on(table.organizationId, table.updatedAt)
			.where(sql`${table.outcome} in ('NEW_VERSION', 'ASSET_STORED') and ${table.versionId} is null`),
		oneOf("geo_site_crawl_items_source_check", table.source, GEO_CRAWL_ITEM_SOURCES),
		oneOf("geo_site_crawl_items_status_check", table.status, GEO_CRAWL_ITEM_STATUSES),
		nullOrOneOf("geo_site_crawl_items_outcome_check", table.outcome, GEO_CRAWL_ITEM_OUTCOMES),
	],
).enableRLS();

/**
 * One row per remote host, shared by every organization and worker: the politeness
 * limit belongs to the site being crawled, so it cannot be split by tenant.
 */
export const geoSiteHostThrottle = pgTable("geo_site_host_throttle", {
	host: text("host").primaryKey().notNull(),
	holder: text("holder"),
	leaseUntil: at("lease_until"),
	nextAllowedAt: at("next_allowed_at").defaultNow().notNull(),
	consecutiveFailures: integer("consecutive_failures").notNull().default(0),
	breakerOpenUntil: at("breaker_open_until"),
	lastSuccessAt: at("last_success_at"),
	updatedAt: updatedAt(),
}).enableRLS();

export const geoSiteQaSamples = pgTable(
	"geo_site_qa_samples",
	{
		id: pk(),
		organizationId: org(),
		siteSourceId: uuid("site_source_id")
			.notNull()
			.references(() => geoSiteSources.id),
		status: text("status").$type<GeoSiteQaSampleStatus>().notNull().default("OPEN"),
		population: integer("population").notNull(),
		sampleSize: integer("sample_size").notNull(),
		seed: text("seed").notNull(),
		createdBy: text("created_by").notNull(),
		completedAt: at("completed_at"),
		createdAt: createdAt(),
	},
	(table) => [
		index("geo_site_qa_samples_source_created_idx").on(table.siteSourceId, table.createdAt),
		oneOf("geo_site_qa_samples_status_check", table.status, GEO_SITE_QA_SAMPLE_STATUSES),
	],
).enableRLS();

export const geoSiteQaItems = pgTable(
	"geo_site_qa_items",
	{
		id: pk(),
		organizationId: org(),
		sampleId: uuid("sample_id")
			.notNull()
			.references(() => geoSiteQaSamples.id),
		pageVersionId: uuid("page_version_id")
			.notNull()
			.references(() => geoSitePageVersions.id),
		fieldPath: text("field_path").notNull(),
		extractedValue: text("extracted_value"),
		verdict: text("verdict").$type<GeoSiteQaVerdict>(),
		note: text("note"),
		reviewerId: text("reviewer_id"),
		reviewedAt: at("reviewed_at"),
		createdAt: createdAt(),
	},
	(table) => [
		uniqueIndex("geo_site_qa_items_sample_version_field_idx").on(table.sampleId, table.pageVersionId, table.fieldPath),
		nullOrOneOf("geo_site_qa_items_verdict_check", table.verdict, GEO_SITE_QA_VERDICTS),
	],
).enableRLS();

export const geoSiteAuditRuns = pgTable(
	"geo_site_audit_runs",
	{
		id: pk(),
		organizationId: org(),
		siteSourceId: uuid("site_source_id")
			.notNull()
			.references(() => geoSiteSources.id),
		status: text("status").$type<GeoSiteAuditRunStatus>().notNull().default("QUEUED"),
		ruleVersion: text("rule_version").notNull(),
		counts: jsonb("counts").notNull().default({}),
		idempotencyKey: text("idempotency_key").notNull(),
		requestedBy: text("requested_by").notNull(),
		/** The crawl whose completion queued this run; null for a run started by hand. */
		crawlRunId: uuid("crawl_run_id").references(() => geoSiteCrawlRuns.id),
		/** Whether robots.txt, the sitemap and HTTPS were probed, or the last answers kept. */
		siteChecks: boolean("site_checks").notNull().default(true),
		errorSummary: text("error_summary"),
		startedAt: at("started_at"),
		finishedAt: at("finished_at"),
		createdAt: createdAt(),
	},
	(table) => [
		uniqueIndex("geo_site_audit_runs_org_key_idx").on(table.organizationId, table.idempotencyKey),
		index("geo_site_audit_runs_source_created_idx").on(table.siteSourceId, table.createdAt),
		oneOf("geo_site_audit_runs_status_check", table.status, GEO_SITE_AUDIT_RUN_STATUSES),
	],
).enableRLS();

export const geoSiteAuditFindings = pgTable(
	"geo_site_audit_findings",
	{
		id: pk(),
		organizationId: org(),
		/** The run that first found it; one row lives on across runs while the problem does. */
		runId: uuid("run_id")
			.notNull()
			.references(() => geoSiteAuditRuns.id),
		siteSourceId: uuid("site_source_id")
			.notNull()
			.references(() => geoSiteSources.id),
		/** Null for a site-wide finding such as a missing sitemap. */
		pageId: uuid("page_id").references(() => geoSitePages.id),
		/** The page id, or `site` for a site-wide finding: what makes a rule's finding the same one next run. */
		subjectKey: text("subject_key").notNull(),
		ruleId: text("rule_id").notNull(),
		ruleVersion: integer("rule_version").notNull().default(1),
		severity: text("severity").$type<GeoFindingSeverity>().notNull(),
		priority: text("priority").$type<GeoPriority>().notNull().default("P2"),
		status: text("status").$type<GeoFindingStatus>().notNull().default("OPEN"),
		/** The page version the evidence was read from, so the snapshot behind it can be opened. */
		pageVersionId: uuid("page_version_id").references(() => geoSitePageVersions.id),
		evidence: jsonb("evidence").notNull().default({}),
		recommendation: text("recommendation"),
		ownerDepartment: text("owner_department"),
		targetPromptIds: uuid("target_prompt_ids").array().notNull().default([]),
		taskId: uuid("task_id").references((): AnyPgColumn => geoOptimizationTasks.id),
		lastRunId: uuid("last_run_id").references(() => geoSiteAuditRuns.id),
		firstSeenAt: at("first_seen_at").notNull().defaultNow(),
		lastSeenAt: at("last_seen_at").notNull().defaultNow(),
		resolvedAt: at("resolved_at"),
		resolvedRunId: uuid("resolved_run_id").references(() => geoSiteAuditRuns.id),
		/** Why it was dismissed, or how it came to be resolved. */
		statusNote: text("status_note"),
		triagedBy: text("triaged_by"),
		triagedAt: at("triaged_at"),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(table) => [
		uniqueIndex("geo_site_audit_findings_run_page_rule_idx").on(table.runId, table.pageId, table.ruleId),
		uniqueIndex("geo_site_audit_findings_subject_idx").on(table.siteSourceId, table.ruleId, table.subjectKey),
		index("geo_site_audit_findings_version_idx").on(table.pageVersionId),
		index("geo_site_audit_findings_org_status_idx").on(table.organizationId, table.status),
		index("geo_site_audit_findings_page_idx").on(table.pageId),
		oneOf("geo_site_audit_findings_severity_check", table.severity, GEO_FINDING_SEVERITIES),
		oneOf("geo_site_audit_findings_status_check", table.status, GEO_FINDING_STATUSES),
		oneOf("geo_site_audit_findings_priority_check", table.priority, GEO_PRIORITIES),
	],
).enableRLS();

// ---------------------------------------------------------------------------
// Knowledge
// ---------------------------------------------------------------------------

export const geoKnowledgeAssets = pgTable(
	"geo_knowledge_assets",
	{
		id: pk(),
		organizationId: org(),
		assetType: text("asset_type").$type<GeoAssetType>().notNull(),
		title: text("title").notNull(),
		sourceUri: text("source_uri"),
		objectKey: text("object_key"),
		mime: text("mime"),
		size: bigint("size", { mode: "number" }),
		sha256: text("sha256"),
		scanStatus: text("scan_status").$type<GeoScanStatus>().notNull().default("PENDING"),
		approvalStatus: text("approval_status").$type<GeoAssetApprovalStatus>().notNull().default("PENDING"),
		validUntil: at("valid_until"),
		publicationScope: text("publication_scope").$type<GeoPublicationScope>().notNull().default("INTERNAL"),
		confidentiality: text("confidentiality").$type<GeoPublicationScope>().notNull().default("INTERNAL"),
		/** The uploader's file name, for display only; the object key is the content hash. */
		fileName: text("file_name"),
		description: text("description"),
		uploadedBy: text("uploaded_by").notNull(),
		reviewNote: text("review_note"),
		reviewedBy: text("reviewed_by"),
		reviewedAt: at("reviewed_at"),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(table) => [
		index("geo_knowledge_assets_org_approval_idx").on(table.organizationId, table.approvalStatus),
		index("geo_knowledge_assets_org_sha256_idx").on(table.organizationId, table.sha256),
		oneOf("geo_knowledge_assets_type_check", table.assetType, GEO_ASSET_TYPES),
		oneOf("geo_knowledge_assets_scan_status_check", table.scanStatus, GEO_SCAN_STATUSES),
		oneOf("geo_knowledge_assets_approval_check", table.approvalStatus, GEO_ASSET_APPROVAL_STATUSES),
		oneOf("geo_knowledge_assets_scope_check", table.publicationScope, GEO_PUBLICATION_SCOPES),
		oneOf("geo_knowledge_assets_confidentiality_check", table.confidentiality, GEO_PUBLICATION_SCOPES),
	],
).enableRLS();

export const geoKnowledgeAssertions = pgTable(
	"geo_knowledge_assertions",
	{
		id: pk(),
		organizationId: org(),
		entityId: uuid("entity_id").references(() => geoSiteEntities.id),
		claimType: text("claim_type").notNull(),
		fieldPath: text("field_path"),
		claimText: text("claim_text").notNull(),
		normalizedValue: jsonb("normalized_value"),
		riskLevel: text("risk_level").$type<GeoRiskLevel>().notNull().default("NORMAL"),
		status: text("status").$type<GeoAssertionStatus>().notNull().default("DISCOVERED"),
		publicationScope: text("publication_scope").$type<GeoPublicationScope>().notNull().default("INTERNAL"),
		validUntil: at("valid_until"),
		supersededBy: uuid("superseded_by"),
		/** CJK bigrams plus ASCII tokens, built in the application so search needs no database extension. */
		searchTokens: text("search_tokens").notNull().default(""),
		/** Null when a crawl extracted it; otherwise who entered it, who may not then approve it. */
		authorId: text("author_id"),
		/** A reviewer's hold on a doubtful fact: no approval and no draft while set. */
		frozenAt: at("frozen_at"),
		frozenBy: text("frozen_by"),
		frozenReason: text("frozen_reason"),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(table) => [
		foreignKey({
			name: "geo_knowledge_assertions_superseded_by_fk",
			columns: [table.supersededBy],
			foreignColumns: [table.id],
		}),
		index("geo_knowledge_assertions_org_status_idx").on(table.organizationId, table.status),
		index("geo_knowledge_assertions_entity_idx").on(table.entityId),
		index("geo_knowledge_assertions_search_idx").using("gin", sql`to_tsvector('simple', ${table.searchTokens})`),
		oneOf("geo_knowledge_assertions_risk_check", table.riskLevel, GEO_RISK_LEVELS),
		oneOf("geo_knowledge_assertions_status_check", table.status, GEO_ASSERTION_STATUSES),
		oneOf("geo_knowledge_assertions_scope_check", table.publicationScope, GEO_PUBLICATION_SCOPES),
	],
).enableRLS();

export const geoAssertionSources = pgTable(
	"geo_assertion_sources",
	{
		id: pk(),
		organizationId: org(),
		assertionId: uuid("assertion_id").notNull(),
		sourceKind: text("source_kind").$type<GeoAssertionSourceKind>().notNull(),
		pageVersionId: uuid("page_version_id"),
		assetId: uuid("asset_id").references(() => geoKnowledgeAssets.id),
		locator: jsonb("locator"),
		parserVersion: text("parser_version"),
		extractedAt: at("extracted_at").notNull(),
		createdAt: createdAt(),
	},
	(table) => [
		foreignKey({
			name: "geo_assertion_sources_assertion_fk",
			columns: [table.assertionId],
			foreignColumns: [geoKnowledgeAssertions.id],
		}),
		foreignKey({
			name: "geo_assertion_sources_page_version_fk",
			columns: [table.pageVersionId],
			foreignColumns: [geoSitePageVersions.id],
		}),
		index("geo_assertion_sources_assertion_idx").on(table.assertionId),
		index("geo_assertion_sources_page_version_idx").on(table.pageVersionId),
		index("geo_assertion_sources_asset_idx").on(table.assetId),
		oneOf("geo_assertion_sources_kind_check", table.sourceKind, GEO_ASSERTION_SOURCE_KINDS),
		check("geo_assertion_sources_one_source_check", exactlyOne(table.pageVersionId, table.assetId)),
	],
).enableRLS();

/** Append-only, enforced by a trigger. */
export const geoAssertionReviews = pgTable(
	"geo_assertion_reviews",
	{
		id: pk(),
		organizationId: org(),
		assertionId: uuid("assertion_id").notNull(),
		decision: text("decision").$type<GeoAssertionReviewDecision>().notNull(),
		reviewerId: text("reviewer_id").notNull(),
		basis: text("basis").notNull(),
		publicationScope: text("publication_scope").$type<GeoPublicationScope>(),
		sourceRef: jsonb("source_ref"),
		reviewedAt: at("reviewed_at").defaultNow().notNull(),
	},
	(table) => [
		foreignKey({
			name: "geo_assertion_reviews_assertion_fk",
			columns: [table.assertionId],
			foreignColumns: [geoKnowledgeAssertions.id],
		}),
		index("geo_assertion_reviews_assertion_idx").on(table.assertionId, table.reviewedAt),
		oneOf("geo_assertion_reviews_decision_check", table.decision, GEO_ASSERTION_REVIEW_DECISIONS),
		nullOrOneOf("geo_assertion_reviews_scope_check", table.publicationScope, GEO_PUBLICATION_SCOPES),
	],
).enableRLS();

export const geoAssertionConflicts = pgTable(
	"geo_assertion_conflicts",
	{
		id: pk(),
		organizationId: org(),
		candidateId: uuid("candidate_id").notNull(),
		approvedId: uuid("approved_id").notNull(),
		status: text("status").$type<GeoConflictStatus>().notNull().default("OPEN"),
		resolution: text("resolution"),
		resolvedBy: text("resolved_by"),
		resolvedAt: at("resolved_at"),
		createdAt: createdAt(),
	},
	(table) => [
		foreignKey({
			name: "geo_assertion_conflicts_candidate_fk",
			columns: [table.candidateId],
			foreignColumns: [geoKnowledgeAssertions.id],
		}),
		foreignKey({
			name: "geo_assertion_conflicts_approved_fk",
			columns: [table.approvedId],
			foreignColumns: [geoKnowledgeAssertions.id],
		}),
		uniqueIndex("geo_assertion_conflicts_open_pair_idx")
			.on(table.candidateId, table.approvedId)
			.where(sql`${table.status} = 'OPEN'`),
		index("geo_assertion_conflicts_org_status_idx").on(table.organizationId, table.status),
		oneOf("geo_assertion_conflicts_status_check", table.status, GEO_CONFLICT_STATUSES),
	],
).enableRLS();

// ---------------------------------------------------------------------------
// Tasks and content
// ---------------------------------------------------------------------------

export const geoOptimizationTasks = pgTable(
	"geo_optimization_tasks",
	{
		id: pk(),
		organizationId: org(),
		title: text("title").notNull(),
		kind: text("kind").$type<GeoTaskKind>().notNull(),
		state: text("state").$type<GeoTaskState>().notNull().default("PENDING_ANALYSIS"),
		pausedFrom: text("paused_from").$type<GeoTaskState>(),
		priority: text("priority").$type<GeoPriority>().notNull().default("P2"),
		promptId: uuid("prompt_id").references(() => geoPrompts.id),
		ownerId: text("owner_id"),
		recommendedAction: text("recommended_action"),
		expectedMetric: text("expected_metric"),
		beforeBatchId: uuid("before_batch_id"),
		afterBatchId: uuid("after_batch_id"),
		publishedUrl: text("published_url"),
		publishedAt: at("published_at"),
		proof: jsonb("proof"),
		launchApprovalRef: text("launch_approval_ref"),
		backupPlan: text("backup_plan"),
		rollbackPlan: text("rollback_plan"),
		riskLevel: text("risk_level").$type<GeoRiskLevel>().notNull().default("NORMAL"),
		sourceKind: text("source_kind").$type<GeoTaskSourceKind>().notNull(),
		sourceRef: text("source_ref"),
		createdBy: text("created_by").notNull(),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(table) => [
		foreignKey({
			name: "geo_optimization_tasks_before_batch_fk",
			columns: [table.beforeBatchId],
			foreignColumns: [geoSamplingBatches.id],
		}),
		foreignKey({
			name: "geo_optimization_tasks_after_batch_fk",
			columns: [table.afterBatchId],
			foreignColumns: [geoSamplingBatches.id],
		}),
		index("geo_optimization_tasks_org_state_idx").on(table.organizationId, table.state),
		index("geo_optimization_tasks_org_owner_idx").on(table.organizationId, table.ownerId),
		index("geo_optimization_tasks_prompt_idx").on(table.promptId),
		// One open task per source, so a double click on "create task" cannot open two.
		uniqueIndex("geo_optimization_tasks_open_source_idx")
			.on(table.organizationId, table.sourceKind, table.sourceRef)
			.where(sql`${table.sourceRef} is not null and ${table.state} not in ('VERIFIED', 'CANCELLED')`),
		oneOf("geo_optimization_tasks_kind_check", table.kind, GEO_TASK_KINDS),
		oneOf("geo_optimization_tasks_state_check", table.state, GEO_TASK_STATES),
		nullOrOneOf("geo_optimization_tasks_paused_from_check", table.pausedFrom, GEO_TASK_STATES),
		oneOf("geo_optimization_tasks_priority_check", table.priority, GEO_PRIORITIES),
		oneOf("geo_optimization_tasks_risk_check", table.riskLevel, GEO_RISK_LEVELS),
		oneOf("geo_optimization_tasks_source_kind_check", table.sourceKind, GEO_TASK_SOURCE_KINDS),
	],
).enableRLS();

/** Append-only, enforced by a trigger. */
export const geoTaskEvents = pgTable(
	"geo_task_events",
	{
		id: pk(),
		organizationId: org(),
		taskId: uuid("task_id")
			.notNull()
			.references(() => geoOptimizationTasks.id),
		fromState: text("from_state").$type<GeoTaskState>(),
		toState: text("to_state").$type<GeoTaskState>().notNull(),
		action: text("action").notNull(),
		actorId: text("actor_id").notNull(),
		comment: text("comment"),
		createdAt: createdAt(),
	},
	(table) => [
		index("geo_task_events_task_created_idx").on(table.taskId, table.createdAt),
		nullOrOneOf("geo_task_events_from_state_check", table.fromState, GEO_TASK_STATES),
		oneOf("geo_task_events_to_state_check", table.toState, GEO_TASK_STATES),
	],
).enableRLS();

export const geoTaskEvidence = pgTable(
	"geo_task_evidence",
	{
		id: pk(),
		organizationId: org(),
		taskId: uuid("task_id")
			.notNull()
			.references(() => geoOptimizationTasks.id),
		observationId: uuid("observation_id").references(() => geoObservations.id),
		findingId: uuid("finding_id").references(() => geoSiteAuditFindings.id),
		assertionId: uuid("assertion_id").references(() => geoKnowledgeAssertions.id),
		createdAt: createdAt(),
	},
	(table) => [
		uniqueIndex("geo_task_evidence_task_observation_idx").on(table.taskId, table.observationId),
		uniqueIndex("geo_task_evidence_task_finding_idx").on(table.taskId, table.findingId),
		uniqueIndex("geo_task_evidence_task_assertion_idx").on(table.taskId, table.assertionId),
		index("geo_task_evidence_observation_idx").on(table.observationId),
		check("geo_task_evidence_one_target_check", exactlyOne(table.observationId, table.findingId, table.assertionId)),
	],
).enableRLS();

export const geoContentItems = pgTable(
	"geo_content_items",
	{
		id: pk(),
		organizationId: org(),
		taskId: uuid("task_id").references(() => geoOptimizationTasks.id),
		kind: text("kind").$type<GeoContentKind>().notNull(),
		title: text("title").notNull(),
		approvalState: text("approval_state").$type<GeoContentApprovalState>().notNull().default("DRAFT"),
		currentVersion: integer("current_version").notNull().default(1),
		authorId: text("author_id").notNull(),
		reviewNote: text("review_note"),
		reviewedBy: text("reviewed_by"),
		reviewedAt: at("reviewed_at"),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(table) => [
		index("geo_content_items_org_state_idx").on(table.organizationId, table.approvalState),
		index("geo_content_items_task_idx").on(table.taskId),
		oneOf("geo_content_items_kind_check", table.kind, GEO_CONTENT_KINDS),
		oneOf("geo_content_items_approval_check", table.approvalState, GEO_CONTENT_APPROVAL_STATES),
	],
).enableRLS();

/** Append-only, enforced by a trigger. */
export const geoContentVersions = pgTable(
	"geo_content_versions",
	{
		id: pk(),
		organizationId: org(),
		itemId: uuid("item_id")
			.notNull()
			.references(() => geoContentItems.id),
		version: integer("version").notNull(),
		body: text("body").notNull(),
		claims: jsonb("claims").notNull().default([]),
		generator: text("generator"),
		model: text("model"),
		validation: jsonb("validation"),
		createdBy: text("created_by").notNull(),
		createdAt: createdAt(),
	},
	(table) => [uniqueIndex("geo_content_versions_item_version_idx").on(table.itemId, table.version)],
).enableRLS();

/** Append-only: every submission, review decision and revision of a content item. */
export const geoContentReviews = pgTable(
	"geo_content_reviews",
	{
		id: pk(),
		organizationId: org(),
		itemId: uuid("item_id")
			.notNull()
			.references(() => geoContentItems.id),
		version: integer("version").notNull(),
		action: text("action").$type<GeoContentAction>().notNull(),
		fromState: text("from_state").$type<GeoContentApprovalState>().notNull(),
		toState: text("to_state").$type<GeoContentApprovalState>().notNull(),
		actorId: text("actor_id").notNull(),
		comment: text("comment"),
		createdAt: createdAt(),
	},
	(table) => [
		index("geo_content_reviews_item_created_idx").on(table.itemId, table.createdAt),
		oneOf("geo_content_reviews_action_check", table.action, GEO_CONTENT_ACTIONS),
		oneOf("geo_content_reviews_from_state_check", table.fromState, GEO_CONTENT_APPROVAL_STATES),
		oneOf("geo_content_reviews_to_state_check", table.toState, GEO_CONTENT_APPROVAL_STATES),
	],
).enableRLS();

export const geoPublicationRecords = pgTable(
	"geo_publication_records",
	{
		id: pk(),
		organizationId: org(),
		itemId: uuid("item_id")
			.notNull()
			.references(() => geoContentItems.id),
		version: integer("version").notNull(),
		url: text("url").notNull(),
		publishedAt: at("published_at").notNull(),
		proof: jsonb("proof"),
		recordedBy: text("recorded_by").notNull(),
		createdAt: createdAt(),
	},
	(table) => [index("geo_publication_records_item_idx").on(table.itemId)],
).enableRLS();

// ---------------------------------------------------------------------------
// Platform
// ---------------------------------------------------------------------------

/** Append-only, enforced by a trigger. Holds hashes rather than values, so it never copies a secret. */
export const geoAuditLogs = pgTable(
	"geo_audit_logs",
	{
		id: pk(),
		organizationId: org(),
		actorId: text("actor_id").notNull(),
		actorKind: text("actor_kind").$type<GeoActorKind>().notNull(),
		action: text("action").notNull(),
		entityType: text("entity_type").notNull(),
		entityId: text("entity_id").notNull(),
		beforeHash: text("before_hash"),
		afterHash: text("after_hash"),
		metadata: jsonb("metadata"),
		requestId: text("request_id"),
		createdAt: createdAt(),
	},
	(table) => [
		index("geo_audit_logs_org_created_idx").on(table.organizationId, table.createdAt),
		index("geo_audit_logs_org_entity_idx").on(table.organizationId, table.entityType, table.entityId),
		index("geo_audit_logs_org_action_idx").on(table.organizationId, table.action),
		oneOf("geo_audit_logs_actor_kind_check", table.actorKind, GEO_ACTOR_KINDS),
	],
).enableRLS();

export const geoGeneratedReports = pgTable(
	"geo_generated_reports",
	{
		id: pk(),
		organizationId: org(),
		periodStart: at("period_start").notNull(),
		periodEnd: at("period_end").notNull(),
		metricVersion: text("metric_version").notNull(),
		filters: jsonb("filters").notNull().default({}),
		snapshot: jsonb("snapshot"),
		pdfObjectKey: text("pdf_object_key"),
		csvObjectKey: text("csv_object_key"),
		/** Why a finished report has no PDF; its snapshot and CSV are still good. */
		pdfUnavailableReason: text("pdf_unavailable_reason"),
		/** Identifies the worker that holds a RUNNING report, so one that was given up on cannot write late. */
		claimToken: text("claim_token"),
		status: text("status").$type<GeoReportStatus>().notNull().default("QUEUED"),
		errorSummary: text("error_summary"),
		generatedBy: text("generated_by").notNull(),
		title: text("title").notNull().default(""),
		reviewStatus: text("review_status").$type<GeoReportReviewStatus>().notNull().default("PENDING"),
		reviewNote: text("review_note"),
		reviewedBy: text("reviewed_by"),
		reviewedAt: at("reviewed_at"),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(table) => [
		index("geo_generated_reports_org_period_idx").on(table.organizationId, table.periodStart),
		oneOf("geo_generated_reports_status_check", table.status, GEO_REPORT_STATUSES),
		oneOf("geo_generated_reports_review_status_check", table.reviewStatus, GEO_REPORT_REVIEW_STATUSES),
	],
).enableRLS();

export const geoAlerts = pgTable(
	"geo_alerts",
	{
		id: pk(),
		organizationId: org(),
		kind: text("kind").notNull(),
		severity: text("severity").$type<GeoAlertSeverity>().notNull(),
		dedupeKey: text("dedupe_key").notNull(),
		status: text("status").$type<GeoAlertStatus>().notNull().default("OPEN"),
		context: jsonb("context").notNull().default({}),
		occurrences: integer("occurrences").notNull().default(1),
		firstSeen: at("first_seen").defaultNow().notNull(),
		lastSeen: at("last_seen").defaultNow().notNull(),
		resolvedAt: at("resolved_at"),
		notifiedAt: at("notified_at"),
	},
	(table) => [
		uniqueIndex("geo_alerts_org_dedupe_active_idx")
			.on(table.organizationId, table.dedupeKey)
			.where(sql`${table.status} <> 'RESOLVED'`),
		index("geo_alerts_org_status_idx").on(table.organizationId, table.status, table.lastSeen),
		oneOf("geo_alerts_severity_check", table.severity, GEO_ALERT_SEVERITIES),
		oneOf("geo_alerts_status_check", table.status, GEO_ALERT_STATUSES),
	],
).enableRLS();

export const geoIdempotencyKeys = pgTable(
	"geo_idempotency_keys",
	{
		organizationId: org(),
		key: text("key").notNull(),
		route: text("route").notNull(),
		requestHash: text("request_hash").notNull(),
		/** Null while the first request with this key is still running. */
		responseStatus: integer("response_status"),
		responseBody: jsonb("response_body"),
		createdAt: createdAt(),
	},
	(table) => [
		primaryKey({ columns: [table.organizationId, table.key, table.route] }),
		index("geo_idempotency_keys_created_idx").on(table.createdAt),
	],
).enableRLS();

/** A change one platform admin proposes and a different one must approve. */
export const geoAdminRequests = pgTable(
	"geo_admin_requests",
	{
		id: pk(),
		organizationId: org(),
		kind: text("kind").$type<GeoAdminRequestKind>().notNull(),
		payload: jsonb("payload").notNull().default({}),
		reason: text("reason").notNull(),
		status: text("status").$type<GeoAdminRequestStatus>().notNull().default("PENDING"),
		requestedBy: text("requested_by").notNull(),
		decidedBy: text("decided_by"),
		decisionComment: text("decision_comment"),
		decidedAt: at("decided_at"),
		expiresAt: at("expires_at").notNull(),
		createdAt: createdAt(),
	},
	(table) => [
		uniqueIndex("geo_admin_requests_org_kind_pending_idx")
			.on(table.organizationId, table.kind)
			.where(sql`${table.status} = 'PENDING'`),
		index("geo_admin_requests_org_created_idx").on(table.organizationId, table.createdAt),
		oneOf("geo_admin_requests_kind_check", table.kind, GEO_ADMIN_REQUEST_KINDS),
		oneOf("geo_admin_requests_status_check", table.status, GEO_ADMIN_REQUEST_STATUSES),
	],
).enableRLS();

/**
 * Written by the backup and restore-drill scripts in infra/backup, which run outside
 * the app. Instance-wide on purpose: one backup covers every organization.
 */
export const geoBackupRuns = pgTable(
	"geo_backup_runs",
	{
		id: pk(),
		kind: text("kind").$type<GeoBackupKind>().notNull(),
		status: text("status").$type<GeoBackupStatus>().notNull(),
		startedAt: at("started_at").notNull(),
		finishedAt: at("finished_at").notNull(),
		databaseBytes: bigint("database_bytes", { mode: "number" }),
		objectCount: integer("object_count"),
		offsiteCopied: boolean("offsite_copied").notNull().default(false),
		durationSeconds: integer("duration_seconds"),
		location: text("location"),
		host: text("host"),
		message: text("message"),
		createdAt: createdAt(),
	},
	(table) => [
		index("geo_backup_runs_kind_finished_idx").on(table.kind, table.finishedAt),
		oneOf("geo_backup_runs_kind_check", table.kind, GEO_BACKUP_KINDS),
		oneOf("geo_backup_runs_status_check", table.status, GEO_BACKUP_STATUSES),
	],
).enableRLS();
