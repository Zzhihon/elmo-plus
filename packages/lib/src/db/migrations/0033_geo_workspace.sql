CREATE TABLE "geo_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"kind" text NOT NULL,
	"severity" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurrences" integer DEFAULT 1 NOT NULL,
	"first_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "geo_alerts_severity_check" CHECK ("geo_alerts"."severity" in ('CRITICAL', 'WARNING', 'INFO')),
	CONSTRAINT "geo_alerts_status_check" CHECK ("geo_alerts"."status" in ('OPEN', 'ACK', 'RESOLVED'))
);
--> statement-breakpoint
ALTER TABLE "geo_alerts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "geo_assertion_conflicts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"candidate_id" uuid NOT NULL,
	"approved_id" uuid NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"resolution" text,
	"resolved_by" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "geo_assertion_conflicts_status_check" CHECK ("geo_assertion_conflicts"."status" in ('OPEN', 'RESOLVED'))
);
--> statement-breakpoint
ALTER TABLE "geo_assertion_conflicts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "geo_assertion_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"assertion_id" uuid NOT NULL,
	"decision" text NOT NULL,
	"reviewer_id" text NOT NULL,
	"basis" text NOT NULL,
	"publication_scope" text,
	"source_ref" jsonb,
	"reviewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "geo_assertion_reviews_decision_check" CHECK ("geo_assertion_reviews"."decision" in ('APPROVE', 'REJECT', 'REQUEST_EVIDENCE', 'INVALIDATE')),
	CONSTRAINT "geo_assertion_reviews_scope_check" CHECK ("geo_assertion_reviews"."publication_scope" is null or "geo_assertion_reviews"."publication_scope" in ('PUBLIC', 'INTERNAL', 'CONFIDENTIAL'))
);
--> statement-breakpoint
ALTER TABLE "geo_assertion_reviews" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "geo_assertion_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"assertion_id" uuid NOT NULL,
	"source_kind" text NOT NULL,
	"page_version_id" uuid,
	"asset_id" uuid,
	"locator" jsonb,
	"parser_version" text,
	"extracted_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "geo_assertion_sources_kind_check" CHECK ("geo_assertion_sources"."source_kind" in ('PAGE_VERSION', 'ASSET')),
	CONSTRAINT "geo_assertion_sources_one_source_check" CHECK (("geo_assertion_sources"."page_version_id" is not null)::int + ("geo_assertion_sources"."asset_id" is not null)::int = 1)
);
--> statement-breakpoint
ALTER TABLE "geo_assertion_sources" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "geo_audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"actor_kind" text NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"before_hash" text,
	"after_hash" text,
	"metadata" jsonb,
	"request_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "geo_audit_logs_actor_kind_check" CHECK ("geo_audit_logs"."actor_kind" in ('user', 'api_key', 'instance_admin_key', 'system'))
);
--> statement-breakpoint
ALTER TABLE "geo_audit_logs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "geo_brand_entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"kind" text NOT NULL,
	"display_name" text NOT NULL,
	"legal_name" text,
	"short_name" text,
	"aliases" text[] DEFAULT '{}' NOT NULL,
	"historical_names" text[] DEFAULT '{}' NOT NULL,
	"domains" text[] DEFAULT '{}' NOT NULL,
	"official_url" text,
	"regions" text[] DEFAULT '{}' NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "geo_brand_entities_kind_check" CHECK ("geo_brand_entities"."kind" in ('OWN', 'COMPETITOR')),
	CONSTRAINT "geo_brand_entities_status_check" CHECK ("geo_brand_entities"."status" in ('ACTIVE', 'DISABLED'))
);
--> statement-breakpoint
ALTER TABLE "geo_brand_entities" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "geo_buyer_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"code" text NOT NULL,
	"title" text NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "geo_buyer_roles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "geo_content_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"task_id" uuid,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"approval_state" text DEFAULT 'DRAFT' NOT NULL,
	"current_version" integer DEFAULT 1 NOT NULL,
	"author_id" text NOT NULL,
	"review_note" text,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "geo_content_items_kind_check" CHECK ("geo_content_items"."kind" in ('FAQ', 'SELECTION_GUIDE', 'CASE', 'COMPANY_INTRO')),
	CONSTRAINT "geo_content_items_approval_check" CHECK ("geo_content_items"."approval_state" in ('DRAFT', 'PENDING_TECH_REVIEW', 'PENDING_MARKETING_REVIEW', 'APPROVED', 'REJECTED', 'PUBLISHED'))
);
--> statement-breakpoint
ALTER TABLE "geo_content_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "geo_content_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"item_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"body" text NOT NULL,
	"claims" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"generator" text,
	"model" text,
	"validation" jsonb,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "geo_content_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "geo_dictionary_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"version" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"change_note" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "geo_dictionary_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "geo_evaluations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"observation_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"evaluator_version" text NOT NULL,
	"dictionary_version_id" uuid,
	"brand_mentioned" boolean NOT NULL,
	"recommendation" text NOT NULL,
	"has_ordered_list" boolean DEFAULT false NOT NULL,
	"brand_rank" integer,
	"competitor_hits" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"evidence_spans" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"confidence" double precision,
	"review_status" text NOT NULL,
	"is_current" boolean DEFAULT true NOT NULL,
	"supersedes_id" uuid,
	"created_by" text NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "geo_evaluations_recommendation_check" CHECK ("geo_evaluations"."recommendation" in ('RECOMMENDED', 'MENTIONED_ONLY', 'NEGATIVE', 'NOT_MENTIONED')),
	CONSTRAINT "geo_evaluations_review_status_check" CHECK ("geo_evaluations"."review_status" in ('AUTO_ACCEPTED', 'PENDING_REVIEW', 'CONFIRMED', 'CORRECTED'))
);
--> statement-breakpoint
ALTER TABLE "geo_evaluations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "geo_generated_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"metric_version" text NOT NULL,
	"filters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"snapshot" jsonb,
	"pdf_object_key" text,
	"csv_object_key" text,
	"status" text DEFAULT 'QUEUED' NOT NULL,
	"error_summary" text,
	"generated_by" text NOT NULL,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "geo_generated_reports_status_check" CHECK ("geo_generated_reports"."status" in ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED'))
);
--> statement-breakpoint
ALTER TABLE "geo_generated_reports" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "geo_idempotency_keys" (
	"organization_id" text NOT NULL,
	"key" text NOT NULL,
	"route" text NOT NULL,
	"request_hash" text NOT NULL,
	"response_status" integer,
	"response_body" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "geo_idempotency_keys_organization_id_key_route_pk" PRIMARY KEY("organization_id","key","route")
);
--> statement-breakpoint
ALTER TABLE "geo_idempotency_keys" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "geo_knowledge_assertions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"entity_id" uuid,
	"claim_type" text NOT NULL,
	"field_path" text,
	"claim_text" text NOT NULL,
	"normalized_value" jsonb,
	"risk_level" text DEFAULT 'NORMAL' NOT NULL,
	"status" text DEFAULT 'DISCOVERED' NOT NULL,
	"publication_scope" text DEFAULT 'INTERNAL' NOT NULL,
	"valid_until" timestamp with time zone,
	"superseded_by" uuid,
	"search_tokens" text DEFAULT '' NOT NULL,
	"author_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "geo_knowledge_assertions_risk_check" CHECK ("geo_knowledge_assertions"."risk_level" in ('HIGH', 'NORMAL')),
	CONSTRAINT "geo_knowledge_assertions_status_check" CHECK ("geo_knowledge_assertions"."status" in ('DISCOVERED', 'PARSED', 'PENDING_REVIEW', 'APPROVED', 'REJECTED', 'NEEDS_EVIDENCE', 'SUPERSEDED', 'SOURCE_UNAVAILABLE')),
	CONSTRAINT "geo_knowledge_assertions_scope_check" CHECK ("geo_knowledge_assertions"."publication_scope" in ('PUBLIC', 'INTERNAL', 'CONFIDENTIAL'))
);
--> statement-breakpoint
ALTER TABLE "geo_knowledge_assertions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "geo_knowledge_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"asset_type" text NOT NULL,
	"title" text NOT NULL,
	"source_uri" text,
	"object_key" text,
	"mime" text,
	"size" bigint,
	"sha256" text,
	"scan_status" text DEFAULT 'PENDING' NOT NULL,
	"approval_status" text DEFAULT 'PENDING' NOT NULL,
	"valid_until" timestamp with time zone,
	"publication_scope" text DEFAULT 'INTERNAL' NOT NULL,
	"confidentiality" text DEFAULT 'INTERNAL' NOT NULL,
	"uploaded_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "geo_knowledge_assets_type_check" CHECK ("geo_knowledge_assets"."asset_type" in ('BRAND_CLAIM', 'CERTIFICATE', 'PRODUCT_SPEC', 'CASE', 'SERVICE_COMMITMENT', 'FAQ')),
	CONSTRAINT "geo_knowledge_assets_scan_status_check" CHECK ("geo_knowledge_assets"."scan_status" in ('PENDING', 'CLEAN', 'INFECTED', 'UNSCANNED')),
	CONSTRAINT "geo_knowledge_assets_approval_check" CHECK ("geo_knowledge_assets"."approval_status" in ('PENDING', 'APPROVED', 'REJECTED')),
	CONSTRAINT "geo_knowledge_assets_scope_check" CHECK ("geo_knowledge_assets"."publication_scope" in ('PUBLIC', 'INTERNAL', 'CONFIDENTIAL')),
	CONSTRAINT "geo_knowledge_assets_confidentiality_check" CHECK ("geo_knowledge_assets"."confidentiality" in ('PUBLIC', 'INTERNAL', 'CONFIDENTIAL'))
);
--> statement-breakpoint
ALTER TABLE "geo_knowledge_assets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "geo_observation_citations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"observation_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"url" text NOT NULL,
	"normalized_url" text,
	"host" text,
	"title" text,
	"source_type" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "geo_observation_citations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "geo_observation_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"observation_id" uuid NOT NULL,
	"evaluation_id" uuid,
	"claim_text" text NOT NULL,
	"span" jsonb,
	"assertion_id" uuid,
	"verdict" text DEFAULT 'UNVERIFIED' NOT NULL,
	"reviewer_id" text,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "geo_observation_claims_verdict_check" CHECK ("geo_observation_claims"."verdict" in ('UNVERIFIED', 'CORRECT', 'ERROR'))
);
--> statement-breakpoint
ALTER TABLE "geo_observation_claims" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "geo_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"run_id" uuid,
	"prompt_id" uuid NOT NULL,
	"prompt_set_id" uuid,
	"prompt_revision" integer NOT NULL,
	"question_text" text NOT NULL,
	"target_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"surface_mode" text NOT NULL,
	"status" text NOT NULL,
	"response_text" text,
	"sampled_at" timestamp with time zone NOT NULL,
	"response_metadata" jsonb,
	"provider_version" text,
	"model_version" text,
	"source_method_version" text,
	"evidence_uri" text,
	"error_code" text,
	"retry_of_observation_id" uuid,
	"import_batch_id" uuid,
	"imported_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "geo_observations_platform_check" CHECK ("geo_observations"."platform" in ('doubao', 'deepseek', 'yuanbao', 'qwen')),
	CONSTRAINT "geo_observations_surface_mode_check" CHECK ("geo_observations"."surface_mode" in ('LIVE_SURFACE', 'MODEL_API', 'MANUAL_EVIDENCE')),
	CONSTRAINT "geo_observations_status_check" CHECK ("geo_observations"."status" in ('VALID', 'PARTIAL', 'UNAVAILABLE', 'NEEDS_MANUAL', 'FAILED', 'RATE_LIMITED', 'TIMEOUT', 'CAPTCHA'))
);
--> statement-breakpoint
ALTER TABLE "geo_observations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "geo_optimization_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"title" text NOT NULL,
	"kind" text NOT NULL,
	"state" text DEFAULT 'PENDING_ANALYSIS' NOT NULL,
	"paused_from" text,
	"priority" text DEFAULT 'P2' NOT NULL,
	"prompt_id" uuid,
	"owner_id" text,
	"recommended_action" text,
	"expected_metric" text,
	"before_batch_id" uuid,
	"after_batch_id" uuid,
	"published_url" text,
	"published_at" timestamp with time zone,
	"proof" jsonb,
	"risk_level" text DEFAULT 'NORMAL' NOT NULL,
	"source_kind" text NOT NULL,
	"source_ref" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "geo_optimization_tasks_kind_check" CHECK ("geo_optimization_tasks"."kind" in ('SELECTION_GUIDE', 'CASE_ADDITION', 'FAQ', 'COMPANY_INTRO', 'SITE_REVISION', 'FACT_CORRECTION', 'OTHER')),
	CONSTRAINT "geo_optimization_tasks_state_check" CHECK ("geo_optimization_tasks"."state" in ('PENDING_ANALYSIS', 'PENDING_ASSIGNMENT', 'IN_PROGRESS', 'PENDING_TECH_REVIEW', 'PENDING_MARKETING_REVIEW', 'PENDING_PUBLISH', 'PUBLISHED', 'PENDING_RETEST', 'VERIFIED', 'REJECTED', 'PAUSED', 'CANCELLED')),
	CONSTRAINT "geo_optimization_tasks_paused_from_check" CHECK ("geo_optimization_tasks"."paused_from" is null or "geo_optimization_tasks"."paused_from" in ('PENDING_ANALYSIS', 'PENDING_ASSIGNMENT', 'IN_PROGRESS', 'PENDING_TECH_REVIEW', 'PENDING_MARKETING_REVIEW', 'PENDING_PUBLISH', 'PUBLISHED', 'PENDING_RETEST', 'VERIFIED', 'REJECTED', 'PAUSED', 'CANCELLED')),
	CONSTRAINT "geo_optimization_tasks_priority_check" CHECK ("geo_optimization_tasks"."priority" in ('P0', 'P1', 'P2', 'P3')),
	CONSTRAINT "geo_optimization_tasks_risk_check" CHECK ("geo_optimization_tasks"."risk_level" in ('HIGH', 'NORMAL')),
	CONSTRAINT "geo_optimization_tasks_source_kind_check" CHECK ("geo_optimization_tasks"."source_kind" in ('OBSERVATION', 'FINDING', 'ASSERTION', 'MANUAL'))
);
--> statement-breakpoint
ALTER TABLE "geo_optimization_tasks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "geo_org_settings" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"llm_use_approved" boolean DEFAULT false NOT NULL,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"sampling_daily_limit" integer,
	"sampling_batch_limit" integer,
	"sampling_cost_budget" numeric(12, 4),
	"evidence_retention_days" integer,
	"snapshot_retention_days" integer,
	"audit_retention_days" integer,
	"alert_recipients" text[] DEFAULT '{}' NOT NULL,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "geo_org_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "geo_products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"brand_entity_id" uuid NOT NULL,
	"model" text,
	"name" text NOT NULL,
	"category" text,
	"term_kind" text NOT NULL,
	"fact_status" text DEFAULT 'UNVERIFIED' NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "geo_products_term_kind_check" CHECK ("geo_products"."term_kind" in ('GENERIC', 'CUSTOMER_MODEL')),
	CONSTRAINT "geo_products_fact_status_check" CHECK ("geo_products"."fact_status" in ('UNVERIFIED', 'PENDING_REVIEW', 'APPROVED', 'REJECTED')),
	CONSTRAINT "geo_products_status_check" CHECK ("geo_products"."status" in ('ACTIVE', 'DISABLED'))
);
--> statement-breakpoint
ALTER TABLE "geo_products" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "geo_prompt_revisions" (
	"organization_id" text NOT NULL,
	"prompt_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"editor_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "geo_prompt_revisions_prompt_id_revision_pk" PRIMARY KEY("prompt_id","revision")
);
--> statement-breakpoint
ALTER TABLE "geo_prompt_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "geo_prompt_set_items" (
	"organization_id" text NOT NULL,
	"set_id" uuid NOT NULL,
	"prompt_id" uuid NOT NULL,
	"prompt_revision" integer NOT NULL,
	"question_text" text NOT NULL,
	"labels" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "geo_prompt_set_items_set_id_prompt_id_pk" PRIMARY KEY("set_id","prompt_id")
);
--> statement-breakpoint
ALTER TABLE "geo_prompt_set_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "geo_prompt_sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"parent_set_id" uuid,
	"frozen_at" timestamp with time zone,
	"frozen_by" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "geo_prompt_sets_status_check" CHECK ("geo_prompt_sets"."status" in ('DRAFT', 'FROZEN'))
);
--> statement-breakpoint
ALTER TABLE "geo_prompt_sets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "geo_prompts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"question" text NOT NULL,
	"buyer_role_id" uuid,
	"intent" text,
	"product_line" text,
	"geo_region" text,
	"priority" text DEFAULT 'P2' NOT NULL,
	"language" text DEFAULT 'zh-CN' NOT NULL,
	"tier" text DEFAULT 'CORE' NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"owner_id" text,
	"reviewer_id" text,
	"review_note" text,
	"current_revision" integer DEFAULT 1 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "geo_prompts_priority_check" CHECK ("geo_prompts"."priority" in ('P0', 'P1', 'P2', 'P3')),
	CONSTRAINT "geo_prompts_tier_check" CHECK ("geo_prompts"."tier" in ('CORE', 'EXTENDED')),
	CONSTRAINT "geo_prompts_status_check" CHECK ("geo_prompts"."status" in ('DRAFT', 'IN_REVIEW', 'BASELINE', 'FROZEN', 'REJECTED'))
);
--> statement-breakpoint
ALTER TABLE "geo_prompts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "geo_publication_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"item_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"url" text NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"proof" jsonb,
	"recorded_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "geo_publication_records" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "geo_role_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"granted_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "geo_role_assignments_role_check" CHECK ("geo_role_assignments"."role" in ('platform_admin', 'geo_operator', 'tech_reviewer', 'marketing_reviewer', 'knowledge_reviewer', 'viewer'))
);
--> statement-breakpoint
ALTER TABLE "geo_role_assignments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "geo_sampling_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"run_id" uuid NOT NULL,
	"attempt_no" integer NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"duration_ms" integer,
	"status" text NOT NULL,
	"error_code" text,
	"cost_estimate" numeric(12, 4),
	"provider_trace_id" text,
	CONSTRAINT "geo_sampling_attempts_status_check" CHECK ("geo_sampling_attempts"."status" in ('RUNNING', 'VALID', 'PARTIAL', 'UNAVAILABLE', 'NEEDS_MANUAL', 'FAILED', 'RATE_LIMITED', 'TIMEOUT', 'CAPTCHA'))
);
--> statement-breakpoint
ALTER TABLE "geo_sampling_attempts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "geo_sampling_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"prompt_set_id" uuid NOT NULL,
	"repeat_count" integer DEFAULT 3 NOT NULL,
	"status" text DEFAULT 'PLANNED' NOT NULL,
	"planned_count" integer DEFAULT 0 NOT NULL,
	"valid_count" integer DEFAULT 0 NOT NULL,
	"partial_count" integer DEFAULT 0 NOT NULL,
	"unavailable_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"cost_estimate" numeric(12, 4),
	"requested_by" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "geo_sampling_batches_status_check" CHECK ("geo_sampling_batches"."status" in ('PLANNED', 'RUNNING', 'PAUSED', 'COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED'))
);
--> statement-breakpoint
ALTER TABLE "geo_sampling_batches" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "geo_sampling_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"batch_id" uuid NOT NULL,
	"prompt_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"repeat_index" integer NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" text DEFAULT 'PLANNED' NOT NULL,
	"retry_of_run_id" uuid,
	"retry_relation" text,
	"error_code" text,
	"error_detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "geo_sampling_runs_status_check" CHECK ("geo_sampling_runs"."status" in ('PLANNED', 'RUNNING', 'VALID', 'PARTIAL', 'UNAVAILABLE', 'NEEDS_MANUAL', 'FAILED', 'RATE_LIMITED', 'TIMEOUT', 'CAPTCHA')),
	CONSTRAINT "geo_sampling_runs_retry_relation_check" CHECK ("geo_sampling_runs"."retry_relation" is null or "geo_sampling_runs"."retry_relation" in ('AUTO_RETRY', 'EXPLICIT_RESAMPLE'))
);
--> statement-breakpoint
ALTER TABLE "geo_sampling_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "geo_sampling_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"platform" text NOT NULL,
	"surface_mode" text NOT NULL,
	"provider" text NOT NULL,
	"model_id" text,
	"region" text,
	"language" text DEFAULT 'zh-CN' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"credential_ref" text,
	"available_window" jsonb,
	"max_concurrency" integer DEFAULT 1 NOT NULL,
	"per_minute_quota" integer,
	"per_day_quota" integer,
	"retry_policy" jsonb,
	"cost_budget" numeric(12, 4),
	"breaker_state" text DEFAULT 'CLOSED' NOT NULL,
	"verification_status" text DEFAULT 'UNVERIFIED' NOT NULL,
	"verification_note" text,
	"enabled" boolean DEFAULT false NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "geo_sampling_targets_platform_check" CHECK ("geo_sampling_targets"."platform" in ('doubao', 'deepseek', 'yuanbao', 'qwen')),
	CONSTRAINT "geo_sampling_targets_surface_mode_check" CHECK ("geo_sampling_targets"."surface_mode" in ('LIVE_SURFACE', 'MODEL_API', 'MANUAL_EVIDENCE')),
	CONSTRAINT "geo_sampling_targets_breaker_check" CHECK ("geo_sampling_targets"."breaker_state" in ('CLOSED', 'OPEN', 'HALF_OPEN')),
	CONSTRAINT "geo_sampling_targets_verification_check" CHECK ("geo_sampling_targets"."verification_status" in ('UNVERIFIED', 'LIMITED', 'PASSED', 'FAILED'))
);
--> statement-breakpoint
ALTER TABLE "geo_sampling_targets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "geo_site_audit_findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"run_id" uuid NOT NULL,
	"page_id" uuid,
	"rule_id" text NOT NULL,
	"severity" text NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"recommendation" text,
	"owner_department" text,
	"target_prompt_ids" uuid[] DEFAULT '{}' NOT NULL,
	"task_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "geo_site_audit_findings_severity_check" CHECK ("geo_site_audit_findings"."severity" in ('HIGH', 'MEDIUM', 'LOW', 'INFO')),
	CONSTRAINT "geo_site_audit_findings_status_check" CHECK ("geo_site_audit_findings"."status" in ('OPEN', 'TASKED', 'RESOLVED', 'DISMISSED'))
);
--> statement-breakpoint
ALTER TABLE "geo_site_audit_findings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "geo_site_audit_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"site_source_id" uuid NOT NULL,
	"status" text DEFAULT 'QUEUED' NOT NULL,
	"rule_version" text NOT NULL,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"requested_by" text NOT NULL,
	"error_summary" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "geo_site_audit_runs_status_check" CHECK ("geo_site_audit_runs"."status" in ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED'))
);
--> statement-breakpoint
ALTER TABLE "geo_site_audit_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "geo_site_crawl_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"site_source_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"status" text DEFAULT 'QUEUED' NOT NULL,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"policy_version" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"requested_by" text NOT NULL,
	"error_summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "geo_site_crawl_runs_mode_check" CHECK ("geo_site_crawl_runs"."mode" in ('FULL', 'INCREMENTAL')),
	CONSTRAINT "geo_site_crawl_runs_status_check" CHECK ("geo_site_crawl_runs"."status" in ('QUEUED', 'RUNNING', 'PAUSED', 'SUCCEEDED', 'PARTIAL', 'FAILED', 'CANCELLED'))
);
--> statement-breakpoint
ALTER TABLE "geo_site_crawl_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "geo_site_entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"kind" text NOT NULL,
	"canonical_key" text NOT NULL,
	"title" text NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'CANDIDATE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "geo_site_entities_kind_check" CHECK ("geo_site_entities"."kind" in ('PRODUCT', 'CASE', 'NEWS', 'COMPANY', 'QUALIFICATION', 'SERVICE')),
	CONSTRAINT "geo_site_entities_status_check" CHECK ("geo_site_entities"."status" in ('CANDIDATE', 'CONFIRMED', 'REJECTED', 'SOURCE_UNAVAILABLE'))
);
--> statement-breakpoint
ALTER TABLE "geo_site_entities" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "geo_site_entity_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"page_version_id" uuid NOT NULL,
	"field_path" text NOT NULL,
	"locator" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "geo_site_entity_sources" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "geo_site_page_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"page_id" uuid NOT NULL,
	"content_hash" text NOT NULL,
	"parser_version" text NOT NULL,
	"html_object_key" text NOT NULL,
	"parsed_object_key" text,
	"title" text,
	"parsed" jsonb,
	"fetched_at" timestamp with time zone NOT NULL,
	"parse_status" text NOT NULL,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "geo_site_page_versions_parse_status_check" CHECK ("geo_site_page_versions"."parse_status" in ('PENDING', 'PARSED', 'FAILED', 'SKIPPED'))
);
--> statement-breakpoint
ALTER TABLE "geo_site_page_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "geo_site_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"site_source_id" uuid NOT NULL,
	"normalized_url" text NOT NULL,
	"canonical_url" text,
	"category" text,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"http_status" integer,
	"last_seen_at" timestamp with time zone,
	"last_fetched_at" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "geo_site_pages_status_check" CHECK ("geo_site_pages"."status" in ('ACTIVE', 'REDIRECTED', 'GONE', 'BLOCKED', 'ERROR'))
);
--> statement-breakpoint
ALTER TABLE "geo_site_pages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "geo_site_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"base_url" text NOT NULL,
	"allowed_hosts" text[] NOT NULL,
	"scope" jsonb,
	"seed_urls" text[] DEFAULT '{}' NOT NULL,
	"profile" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"policy_version" text NOT NULL,
	"requests_per_second" double precision DEFAULT 1 NOT NULL,
	"concurrency" integer DEFAULT 1 NOT NULL,
	"max_pages" integer,
	"max_asset_bytes" bigint,
	"op_window" jsonb,
	"crawl_cron" text,
	"user_agent_contact" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_success_at" timestamp with time zone,
	"authorization_note" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "geo_site_sources" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "geo_task_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"task_id" uuid NOT NULL,
	"from_state" text,
	"to_state" text NOT NULL,
	"action" text NOT NULL,
	"actor_id" text NOT NULL,
	"comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "geo_task_events_from_state_check" CHECK ("geo_task_events"."from_state" is null or "geo_task_events"."from_state" in ('PENDING_ANALYSIS', 'PENDING_ASSIGNMENT', 'IN_PROGRESS', 'PENDING_TECH_REVIEW', 'PENDING_MARKETING_REVIEW', 'PENDING_PUBLISH', 'PUBLISHED', 'PENDING_RETEST', 'VERIFIED', 'REJECTED', 'PAUSED', 'CANCELLED')),
	CONSTRAINT "geo_task_events_to_state_check" CHECK ("geo_task_events"."to_state" in ('PENDING_ANALYSIS', 'PENDING_ASSIGNMENT', 'IN_PROGRESS', 'PENDING_TECH_REVIEW', 'PENDING_MARKETING_REVIEW', 'PENDING_PUBLISH', 'PUBLISHED', 'PENDING_RETEST', 'VERIFIED', 'REJECTED', 'PAUSED', 'CANCELLED'))
);
--> statement-breakpoint
ALTER TABLE "geo_task_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "geo_task_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"task_id" uuid NOT NULL,
	"observation_id" uuid,
	"finding_id" uuid,
	"assertion_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "geo_task_evidence_one_target_check" CHECK (("geo_task_evidence"."observation_id" is not null)::int + ("geo_task_evidence"."finding_id" is not null)::int + ("geo_task_evidence"."assertion_id" is not null)::int = 1)
);
--> statement-breakpoint
ALTER TABLE "geo_task_evidence" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "geo_alerts" ADD CONSTRAINT "geo_alerts_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_assertion_conflicts" ADD CONSTRAINT "geo_assertion_conflicts_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_assertion_conflicts" ADD CONSTRAINT "geo_assertion_conflicts_candidate_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."geo_knowledge_assertions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_assertion_conflicts" ADD CONSTRAINT "geo_assertion_conflicts_approved_fk" FOREIGN KEY ("approved_id") REFERENCES "public"."geo_knowledge_assertions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_assertion_reviews" ADD CONSTRAINT "geo_assertion_reviews_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_assertion_reviews" ADD CONSTRAINT "geo_assertion_reviews_assertion_fk" FOREIGN KEY ("assertion_id") REFERENCES "public"."geo_knowledge_assertions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_assertion_sources" ADD CONSTRAINT "geo_assertion_sources_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_assertion_sources" ADD CONSTRAINT "geo_assertion_sources_asset_id_geo_knowledge_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."geo_knowledge_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_assertion_sources" ADD CONSTRAINT "geo_assertion_sources_assertion_fk" FOREIGN KEY ("assertion_id") REFERENCES "public"."geo_knowledge_assertions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_assertion_sources" ADD CONSTRAINT "geo_assertion_sources_page_version_fk" FOREIGN KEY ("page_version_id") REFERENCES "public"."geo_site_page_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_audit_logs" ADD CONSTRAINT "geo_audit_logs_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_brand_entities" ADD CONSTRAINT "geo_brand_entities_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_buyer_roles" ADD CONSTRAINT "geo_buyer_roles_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_content_items" ADD CONSTRAINT "geo_content_items_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_content_items" ADD CONSTRAINT "geo_content_items_task_id_geo_optimization_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."geo_optimization_tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_content_versions" ADD CONSTRAINT "geo_content_versions_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_content_versions" ADD CONSTRAINT "geo_content_versions_item_id_geo_content_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."geo_content_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_dictionary_versions" ADD CONSTRAINT "geo_dictionary_versions_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_evaluations" ADD CONSTRAINT "geo_evaluations_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_evaluations" ADD CONSTRAINT "geo_evaluations_observation_id_geo_observations_id_fk" FOREIGN KEY ("observation_id") REFERENCES "public"."geo_observations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_evaluations" ADD CONSTRAINT "geo_evaluations_supersedes_id_geo_evaluations_id_fk" FOREIGN KEY ("supersedes_id") REFERENCES "public"."geo_evaluations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_evaluations" ADD CONSTRAINT "geo_evaluations_dictionary_version_fk" FOREIGN KEY ("dictionary_version_id") REFERENCES "public"."geo_dictionary_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_generated_reports" ADD CONSTRAINT "geo_generated_reports_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_idempotency_keys" ADD CONSTRAINT "geo_idempotency_keys_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_knowledge_assertions" ADD CONSTRAINT "geo_knowledge_assertions_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_knowledge_assertions" ADD CONSTRAINT "geo_knowledge_assertions_entity_id_geo_site_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."geo_site_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_knowledge_assertions" ADD CONSTRAINT "geo_knowledge_assertions_superseded_by_fk" FOREIGN KEY ("superseded_by") REFERENCES "public"."geo_knowledge_assertions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_knowledge_assets" ADD CONSTRAINT "geo_knowledge_assets_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_observation_citations" ADD CONSTRAINT "geo_observation_citations_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_observation_citations" ADD CONSTRAINT "geo_observation_citations_observation_id_geo_observations_id_fk" FOREIGN KEY ("observation_id") REFERENCES "public"."geo_observations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_observation_claims" ADD CONSTRAINT "geo_observation_claims_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_observation_claims" ADD CONSTRAINT "geo_observation_claims_observation_id_geo_observations_id_fk" FOREIGN KEY ("observation_id") REFERENCES "public"."geo_observations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_observation_claims" ADD CONSTRAINT "geo_observation_claims_evaluation_id_geo_evaluations_id_fk" FOREIGN KEY ("evaluation_id") REFERENCES "public"."geo_evaluations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_observation_claims" ADD CONSTRAINT "geo_observation_claims_assertion_fk" FOREIGN KEY ("assertion_id") REFERENCES "public"."geo_knowledge_assertions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_observations" ADD CONSTRAINT "geo_observations_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_observations" ADD CONSTRAINT "geo_observations_run_id_geo_sampling_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."geo_sampling_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_observations" ADD CONSTRAINT "geo_observations_prompt_id_geo_prompts_id_fk" FOREIGN KEY ("prompt_id") REFERENCES "public"."geo_prompts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_observations" ADD CONSTRAINT "geo_observations_prompt_set_id_geo_prompt_sets_id_fk" FOREIGN KEY ("prompt_set_id") REFERENCES "public"."geo_prompt_sets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_observations" ADD CONSTRAINT "geo_observations_target_id_geo_sampling_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."geo_sampling_targets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_observations" ADD CONSTRAINT "geo_observations_retry_of_observation_id_geo_observations_id_fk" FOREIGN KEY ("retry_of_observation_id") REFERENCES "public"."geo_observations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_optimization_tasks" ADD CONSTRAINT "geo_optimization_tasks_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_optimization_tasks" ADD CONSTRAINT "geo_optimization_tasks_prompt_id_geo_prompts_id_fk" FOREIGN KEY ("prompt_id") REFERENCES "public"."geo_prompts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_optimization_tasks" ADD CONSTRAINT "geo_optimization_tasks_before_batch_fk" FOREIGN KEY ("before_batch_id") REFERENCES "public"."geo_sampling_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_optimization_tasks" ADD CONSTRAINT "geo_optimization_tasks_after_batch_fk" FOREIGN KEY ("after_batch_id") REFERENCES "public"."geo_sampling_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_org_settings" ADD CONSTRAINT "geo_org_settings_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_products" ADD CONSTRAINT "geo_products_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_products" ADD CONSTRAINT "geo_products_brand_entity_id_geo_brand_entities_id_fk" FOREIGN KEY ("brand_entity_id") REFERENCES "public"."geo_brand_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_prompt_revisions" ADD CONSTRAINT "geo_prompt_revisions_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_prompt_revisions" ADD CONSTRAINT "geo_prompt_revisions_prompt_id_geo_prompts_id_fk" FOREIGN KEY ("prompt_id") REFERENCES "public"."geo_prompts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_prompt_set_items" ADD CONSTRAINT "geo_prompt_set_items_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_prompt_set_items" ADD CONSTRAINT "geo_prompt_set_items_set_id_geo_prompt_sets_id_fk" FOREIGN KEY ("set_id") REFERENCES "public"."geo_prompt_sets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_prompt_set_items" ADD CONSTRAINT "geo_prompt_set_items_prompt_id_geo_prompts_id_fk" FOREIGN KEY ("prompt_id") REFERENCES "public"."geo_prompts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_prompt_sets" ADD CONSTRAINT "geo_prompt_sets_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_prompt_sets" ADD CONSTRAINT "geo_prompt_sets_parent_set_id_geo_prompt_sets_id_fk" FOREIGN KEY ("parent_set_id") REFERENCES "public"."geo_prompt_sets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_prompts" ADD CONSTRAINT "geo_prompts_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_prompts" ADD CONSTRAINT "geo_prompts_buyer_role_id_geo_buyer_roles_id_fk" FOREIGN KEY ("buyer_role_id") REFERENCES "public"."geo_buyer_roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_publication_records" ADD CONSTRAINT "geo_publication_records_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_publication_records" ADD CONSTRAINT "geo_publication_records_item_id_geo_content_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."geo_content_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_role_assignments" ADD CONSTRAINT "geo_role_assignments_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_role_assignments" ADD CONSTRAINT "geo_role_assignments_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_sampling_attempts" ADD CONSTRAINT "geo_sampling_attempts_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_sampling_attempts" ADD CONSTRAINT "geo_sampling_attempts_run_id_geo_sampling_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."geo_sampling_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_sampling_batches" ADD CONSTRAINT "geo_sampling_batches_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_sampling_batches" ADD CONSTRAINT "geo_sampling_batches_prompt_set_id_geo_prompt_sets_id_fk" FOREIGN KEY ("prompt_set_id") REFERENCES "public"."geo_prompt_sets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_sampling_runs" ADD CONSTRAINT "geo_sampling_runs_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_sampling_runs" ADD CONSTRAINT "geo_sampling_runs_batch_id_geo_sampling_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."geo_sampling_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_sampling_runs" ADD CONSTRAINT "geo_sampling_runs_prompt_id_geo_prompts_id_fk" FOREIGN KEY ("prompt_id") REFERENCES "public"."geo_prompts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_sampling_runs" ADD CONSTRAINT "geo_sampling_runs_target_id_geo_sampling_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."geo_sampling_targets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_sampling_runs" ADD CONSTRAINT "geo_sampling_runs_retry_of_run_id_geo_sampling_runs_id_fk" FOREIGN KEY ("retry_of_run_id") REFERENCES "public"."geo_sampling_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_sampling_targets" ADD CONSTRAINT "geo_sampling_targets_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_site_audit_findings" ADD CONSTRAINT "geo_site_audit_findings_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_site_audit_findings" ADD CONSTRAINT "geo_site_audit_findings_run_id_geo_site_audit_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."geo_site_audit_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_site_audit_findings" ADD CONSTRAINT "geo_site_audit_findings_page_id_geo_site_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."geo_site_pages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_site_audit_findings" ADD CONSTRAINT "geo_site_audit_findings_task_id_geo_optimization_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."geo_optimization_tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_site_audit_runs" ADD CONSTRAINT "geo_site_audit_runs_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_site_audit_runs" ADD CONSTRAINT "geo_site_audit_runs_site_source_id_geo_site_sources_id_fk" FOREIGN KEY ("site_source_id") REFERENCES "public"."geo_site_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_site_crawl_runs" ADD CONSTRAINT "geo_site_crawl_runs_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_site_crawl_runs" ADD CONSTRAINT "geo_site_crawl_runs_site_source_id_geo_site_sources_id_fk" FOREIGN KEY ("site_source_id") REFERENCES "public"."geo_site_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_site_entities" ADD CONSTRAINT "geo_site_entities_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_site_entity_sources" ADD CONSTRAINT "geo_site_entity_sources_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_site_entity_sources" ADD CONSTRAINT "geo_site_entity_sources_entity_id_geo_site_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."geo_site_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_site_entity_sources" ADD CONSTRAINT "geo_site_entity_sources_page_version_fk" FOREIGN KEY ("page_version_id") REFERENCES "public"."geo_site_page_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_site_page_versions" ADD CONSTRAINT "geo_site_page_versions_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_site_page_versions" ADD CONSTRAINT "geo_site_page_versions_page_id_geo_site_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."geo_site_pages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_site_pages" ADD CONSTRAINT "geo_site_pages_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_site_pages" ADD CONSTRAINT "geo_site_pages_site_source_id_geo_site_sources_id_fk" FOREIGN KEY ("site_source_id") REFERENCES "public"."geo_site_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_site_sources" ADD CONSTRAINT "geo_site_sources_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_task_events" ADD CONSTRAINT "geo_task_events_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_task_events" ADD CONSTRAINT "geo_task_events_task_id_geo_optimization_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."geo_optimization_tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_task_evidence" ADD CONSTRAINT "geo_task_evidence_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_task_evidence" ADD CONSTRAINT "geo_task_evidence_task_id_geo_optimization_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."geo_optimization_tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_task_evidence" ADD CONSTRAINT "geo_task_evidence_observation_id_geo_observations_id_fk" FOREIGN KEY ("observation_id") REFERENCES "public"."geo_observations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_task_evidence" ADD CONSTRAINT "geo_task_evidence_finding_id_geo_site_audit_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."geo_site_audit_findings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_task_evidence" ADD CONSTRAINT "geo_task_evidence_assertion_id_geo_knowledge_assertions_id_fk" FOREIGN KEY ("assertion_id") REFERENCES "public"."geo_knowledge_assertions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "geo_alerts_org_dedupe_active_idx" ON "geo_alerts" USING btree ("organization_id","dedupe_key") WHERE "geo_alerts"."status" <> 'RESOLVED';--> statement-breakpoint
CREATE INDEX "geo_alerts_org_status_idx" ON "geo_alerts" USING btree ("organization_id","status","last_seen");--> statement-breakpoint
CREATE UNIQUE INDEX "geo_assertion_conflicts_open_pair_idx" ON "geo_assertion_conflicts" USING btree ("candidate_id","approved_id") WHERE "geo_assertion_conflicts"."status" = 'OPEN';--> statement-breakpoint
CREATE INDEX "geo_assertion_conflicts_org_status_idx" ON "geo_assertion_conflicts" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "geo_assertion_reviews_assertion_idx" ON "geo_assertion_reviews" USING btree ("assertion_id","reviewed_at");--> statement-breakpoint
CREATE INDEX "geo_assertion_sources_assertion_idx" ON "geo_assertion_sources" USING btree ("assertion_id");--> statement-breakpoint
CREATE INDEX "geo_assertion_sources_page_version_idx" ON "geo_assertion_sources" USING btree ("page_version_id");--> statement-breakpoint
CREATE INDEX "geo_assertion_sources_asset_idx" ON "geo_assertion_sources" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX "geo_audit_logs_org_created_idx" ON "geo_audit_logs" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "geo_audit_logs_org_entity_idx" ON "geo_audit_logs" USING btree ("organization_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "geo_audit_logs_org_action_idx" ON "geo_audit_logs" USING btree ("organization_id","action");--> statement-breakpoint
CREATE UNIQUE INDEX "geo_brand_entities_org_name_idx" ON "geo_brand_entities" USING btree ("organization_id","display_name");--> statement-breakpoint
CREATE INDEX "geo_brand_entities_org_kind_idx" ON "geo_brand_entities" USING btree ("organization_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "geo_buyer_roles_org_code_idx" ON "geo_buyer_roles" USING btree ("organization_id","code");--> statement-breakpoint
CREATE INDEX "geo_content_items_org_state_idx" ON "geo_content_items" USING btree ("organization_id","approval_state");--> statement-breakpoint
CREATE INDEX "geo_content_items_task_idx" ON "geo_content_items" USING btree ("task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "geo_content_versions_item_version_idx" ON "geo_content_versions" USING btree ("item_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "geo_dictionary_versions_org_version_idx" ON "geo_dictionary_versions" USING btree ("organization_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "geo_evaluations_observation_version_idx" ON "geo_evaluations" USING btree ("observation_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "geo_evaluations_observation_current_idx" ON "geo_evaluations" USING btree ("observation_id") WHERE "geo_evaluations"."is_current" = true;--> statement-breakpoint
CREATE INDEX "geo_evaluations_org_review_idx" ON "geo_evaluations" USING btree ("organization_id","review_status");--> statement-breakpoint
CREATE INDEX "geo_generated_reports_org_period_idx" ON "geo_generated_reports" USING btree ("organization_id","period_start");--> statement-breakpoint
CREATE INDEX "geo_idempotency_keys_created_idx" ON "geo_idempotency_keys" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "geo_knowledge_assertions_org_status_idx" ON "geo_knowledge_assertions" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "geo_knowledge_assertions_entity_idx" ON "geo_knowledge_assertions" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "geo_knowledge_assertions_search_idx" ON "geo_knowledge_assertions" USING gin (to_tsvector('simple', "search_tokens"));--> statement-breakpoint
CREATE INDEX "geo_knowledge_assets_org_approval_idx" ON "geo_knowledge_assets" USING btree ("organization_id","approval_status");--> statement-breakpoint
CREATE INDEX "geo_knowledge_assets_org_sha256_idx" ON "geo_knowledge_assets" USING btree ("organization_id","sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "geo_observation_citations_observation_ordinal_idx" ON "geo_observation_citations" USING btree ("observation_id","ordinal");--> statement-breakpoint
CREATE INDEX "geo_observation_citations_org_host_idx" ON "geo_observation_citations" USING btree ("organization_id","host");--> statement-breakpoint
CREATE INDEX "geo_observation_claims_observation_idx" ON "geo_observation_claims" USING btree ("observation_id");--> statement-breakpoint
CREATE INDEX "geo_observation_claims_org_verdict_idx" ON "geo_observation_claims" USING btree ("organization_id","verdict");--> statement-breakpoint
CREATE UNIQUE INDEX "geo_observations_run_idx" ON "geo_observations" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "geo_observations_org_sampled_idx" ON "geo_observations" USING btree ("organization_id","sampled_at");--> statement-breakpoint
CREATE INDEX "geo_observations_org_prompt_target_idx" ON "geo_observations" USING btree ("organization_id","prompt_id","target_id","sampled_at");--> statement-breakpoint
CREATE INDEX "geo_observations_org_set_idx" ON "geo_observations" USING btree ("organization_id","prompt_set_id");--> statement-breakpoint
CREATE INDEX "geo_observations_org_status_idx" ON "geo_observations" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "geo_optimization_tasks_org_state_idx" ON "geo_optimization_tasks" USING btree ("organization_id","state");--> statement-breakpoint
CREATE INDEX "geo_optimization_tasks_org_owner_idx" ON "geo_optimization_tasks" USING btree ("organization_id","owner_id");--> statement-breakpoint
CREATE INDEX "geo_optimization_tasks_prompt_idx" ON "geo_optimization_tasks" USING btree ("prompt_id");--> statement-breakpoint
CREATE UNIQUE INDEX "geo_optimization_tasks_open_source_idx" ON "geo_optimization_tasks" USING btree ("organization_id","source_kind","source_ref") WHERE "geo_optimization_tasks"."source_ref" is not null and "geo_optimization_tasks"."state" not in ('VERIFIED', 'CANCELLED');--> statement-breakpoint
CREATE UNIQUE INDEX "geo_products_org_brand_name_model_idx" ON "geo_products" USING btree ("organization_id","brand_entity_id","name","model");--> statement-breakpoint
CREATE INDEX "geo_products_brand_idx" ON "geo_products" USING btree ("brand_entity_id");--> statement-breakpoint
CREATE INDEX "geo_prompt_set_items_prompt_idx" ON "geo_prompt_set_items" USING btree ("prompt_id");--> statement-breakpoint
CREATE UNIQUE INDEX "geo_prompt_sets_org_name_version_idx" ON "geo_prompt_sets" USING btree ("organization_id","name","version");--> statement-breakpoint
CREATE INDEX "geo_prompts_org_status_idx" ON "geo_prompts" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "geo_prompts_org_role_idx" ON "geo_prompts" USING btree ("organization_id","buyer_role_id");--> statement-breakpoint
CREATE INDEX "geo_publication_records_item_idx" ON "geo_publication_records" USING btree ("item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "geo_role_assignments_org_user_role_idx" ON "geo_role_assignments" USING btree ("organization_id","user_id","role");--> statement-breakpoint
CREATE INDEX "geo_role_assignments_user_idx" ON "geo_role_assignments" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "geo_sampling_attempts_run_attempt_idx" ON "geo_sampling_attempts" USING btree ("run_id","attempt_no");--> statement-breakpoint
CREATE UNIQUE INDEX "geo_sampling_batches_org_key_idx" ON "geo_sampling_batches" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "geo_sampling_batches_org_status_idx" ON "geo_sampling_batches" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "geo_sampling_batches_set_idx" ON "geo_sampling_batches" USING btree ("prompt_set_id");--> statement-breakpoint
CREATE UNIQUE INDEX "geo_sampling_runs_idempotency_key_idx" ON "geo_sampling_runs" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "geo_sampling_runs_batch_status_idx" ON "geo_sampling_runs" USING btree ("batch_id","status");--> statement-breakpoint
CREATE INDEX "geo_sampling_runs_org_status_idx" ON "geo_sampling_runs" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "geo_sampling_runs_target_idx" ON "geo_sampling_runs" USING btree ("target_id");--> statement-breakpoint
CREATE INDEX "geo_sampling_targets_org_platform_idx" ON "geo_sampling_targets" USING btree ("organization_id","platform","surface_mode");--> statement-breakpoint
CREATE UNIQUE INDEX "geo_site_audit_findings_run_page_rule_idx" ON "geo_site_audit_findings" USING btree ("run_id","page_id","rule_id");--> statement-breakpoint
CREATE INDEX "geo_site_audit_findings_org_status_idx" ON "geo_site_audit_findings" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "geo_site_audit_findings_page_idx" ON "geo_site_audit_findings" USING btree ("page_id");--> statement-breakpoint
CREATE UNIQUE INDEX "geo_site_audit_runs_org_key_idx" ON "geo_site_audit_runs" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "geo_site_audit_runs_source_created_idx" ON "geo_site_audit_runs" USING btree ("site_source_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "geo_site_crawl_runs_org_key_idx" ON "geo_site_crawl_runs" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "geo_site_crawl_runs_source_created_idx" ON "geo_site_crawl_runs" USING btree ("site_source_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "geo_site_entities_org_kind_key_idx" ON "geo_site_entities" USING btree ("organization_id","kind","canonical_key");--> statement-breakpoint
CREATE UNIQUE INDEX "geo_site_entity_sources_entity_version_field_idx" ON "geo_site_entity_sources" USING btree ("entity_id","page_version_id","field_path");--> statement-breakpoint
CREATE INDEX "geo_site_entity_sources_version_idx" ON "geo_site_entity_sources" USING btree ("page_version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "geo_site_page_versions_page_hash_parser_idx" ON "geo_site_page_versions" USING btree ("page_id","content_hash","parser_version");--> statement-breakpoint
CREATE INDEX "geo_site_page_versions_page_fetched_idx" ON "geo_site_page_versions" USING btree ("page_id","fetched_at");--> statement-breakpoint
CREATE UNIQUE INDEX "geo_site_pages_org_source_url_idx" ON "geo_site_pages" USING btree ("organization_id","site_source_id","normalized_url");--> statement-breakpoint
CREATE INDEX "geo_site_pages_org_status_idx" ON "geo_site_pages" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "geo_site_pages_org_category_idx" ON "geo_site_pages" USING btree ("organization_id","category");--> statement-breakpoint
CREATE UNIQUE INDEX "geo_site_sources_org_base_url_idx" ON "geo_site_sources" USING btree ("organization_id","base_url");--> statement-breakpoint
CREATE INDEX "geo_task_events_task_created_idx" ON "geo_task_events" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "geo_task_evidence_task_observation_idx" ON "geo_task_evidence" USING btree ("task_id","observation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "geo_task_evidence_task_finding_idx" ON "geo_task_evidence" USING btree ("task_id","finding_id");--> statement-breakpoint
CREATE UNIQUE INDEX "geo_task_evidence_task_assertion_idx" ON "geo_task_evidence" USING btree ("task_id","assertion_id");--> statement-breakpoint
CREATE INDEX "geo_task_evidence_observation_idx" ON "geo_task_evidence" USING btree ("observation_id");--> statement-breakpoint
CREATE FUNCTION "geo_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	-- Only the retention purge may delete, and only inside a transaction that set
	-- geo.retention_purge with SET LOCAL. UPDATE is refused unconditionally.
	IF TG_OP = 'DELETE' AND current_setting('geo.retention_purge', true) = 'on' THEN
		RETURN OLD;
	END IF;
	RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "geo_observations_append_only" BEFORE UPDATE OR DELETE ON "geo_observations"
	FOR EACH ROW EXECUTE FUNCTION "geo_append_only"();--> statement-breakpoint
CREATE TRIGGER "geo_site_page_versions_append_only" BEFORE UPDATE OR DELETE ON "geo_site_page_versions"
	FOR EACH ROW EXECUTE FUNCTION "geo_append_only"();--> statement-breakpoint
CREATE TRIGGER "geo_content_versions_append_only" BEFORE UPDATE OR DELETE ON "geo_content_versions"
	FOR EACH ROW EXECUTE FUNCTION "geo_append_only"();--> statement-breakpoint
CREATE TRIGGER "geo_dictionary_versions_append_only" BEFORE UPDATE OR DELETE ON "geo_dictionary_versions"
	FOR EACH ROW EXECUTE FUNCTION "geo_append_only"();--> statement-breakpoint
CREATE TRIGGER "geo_audit_logs_append_only" BEFORE UPDATE OR DELETE ON "geo_audit_logs"
	FOR EACH ROW EXECUTE FUNCTION "geo_append_only"();--> statement-breakpoint
CREATE TRIGGER "geo_assertion_reviews_append_only" BEFORE UPDATE OR DELETE ON "geo_assertion_reviews"
	FOR EACH ROW EXECUTE FUNCTION "geo_append_only"();--> statement-breakpoint
CREATE TRIGGER "geo_task_events_append_only" BEFORE UPDATE OR DELETE ON "geo_task_events"
	FOR EACH ROW EXECUTE FUNCTION "geo_append_only"();
