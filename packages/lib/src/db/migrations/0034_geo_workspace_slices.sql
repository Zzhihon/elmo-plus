CREATE TABLE "two_factor" (
	"id" text PRIMARY KEY NOT NULL,
	"secret" text NOT NULL,
	"backup_codes" text NOT NULL,
	"user_id" text NOT NULL,
	"verified" boolean DEFAULT true,
	"failed_verification_count" integer DEFAULT 0,
	"locked_until" timestamp
);
--> statement-breakpoint
CREATE TABLE "geo_admin_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"requested_by" text NOT NULL,
	"decided_by" text,
	"decision_comment" text,
	"decided_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "geo_admin_requests_kind_check" CHECK ("geo_admin_requests"."kind" in ('LLM_USE_APPROVAL', 'RETENTION_CHANGE', 'ADMIN_MFA_POLICY')),
	CONSTRAINT "geo_admin_requests_status_check" CHECK ("geo_admin_requests"."status" in ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'EXPIRED'))
);
--> statement-breakpoint
ALTER TABLE "geo_admin_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "geo_backup_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	"database_bytes" bigint,
	"object_count" integer,
	"offsite_copied" boolean DEFAULT false NOT NULL,
	"duration_seconds" integer,
	"location" text,
	"host" text,
	"message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "geo_backup_runs_kind_check" CHECK ("geo_backup_runs"."kind" in ('DAILY', 'PRE_MIGRATION', 'RESTORE_DRILL')),
	CONSTRAINT "geo_backup_runs_status_check" CHECK ("geo_backup_runs"."status" in ('SUCCEEDED', 'FAILED'))
);
--> statement-breakpoint
ALTER TABLE "geo_backup_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "geo_content_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"item_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"action" text NOT NULL,
	"from_state" text NOT NULL,
	"to_state" text NOT NULL,
	"actor_id" text NOT NULL,
	"comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "geo_content_reviews_action_check" CHECK ("geo_content_reviews"."action" in ('SUBMIT', 'APPROVE_TECH', 'APPROVE_MARKETING', 'REJECT', 'REVISE', 'PUBLISH')),
	CONSTRAINT "geo_content_reviews_from_state_check" CHECK ("geo_content_reviews"."from_state" in ('DRAFT', 'PENDING_TECH_REVIEW', 'PENDING_MARKETING_REVIEW', 'APPROVED', 'REJECTED', 'PUBLISHED')),
	CONSTRAINT "geo_content_reviews_to_state_check" CHECK ("geo_content_reviews"."to_state" in ('DRAFT', 'PENDING_TECH_REVIEW', 'PENDING_MARKETING_REVIEW', 'APPROVED', 'REJECTED', 'PUBLISHED'))
);
--> statement-breakpoint
ALTER TABLE "geo_content_reviews" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "geo_site_crawl_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"run_id" uuid NOT NULL,
	"url" text NOT NULL,
	"source" text NOT NULL,
	"depth" integer DEFAULT 0 NOT NULL,
	"priority" integer DEFAULT 2 NOT NULL,
	"is_asset" boolean DEFAULT false NOT NULL,
	"discovered_from" text,
	"status" text DEFAULT 'QUEUED' NOT NULL,
	"outcome" text,
	"page_id" uuid,
	"http_status" integer,
	"attempts" integer DEFAULT 0 NOT NULL,
	"duration_ms" integer,
	"final_url" text,
	"content_hash" text,
	"raw_object_key" text,
	"fetched_at" timestamp with time zone,
	"version_id" uuid,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "geo_site_crawl_items_source_check" CHECK ("geo_site_crawl_items"."source" in ('SEED', 'SITEMAP', 'KNOWN', 'LINK', 'PAGINATION', 'CANONICAL', 'REDIRECT')),
	CONSTRAINT "geo_site_crawl_items_status_check" CHECK ("geo_site_crawl_items"."status" in ('QUEUED', 'FETCHING', 'DONE', 'FAILED', 'SKIPPED')),
	CONSTRAINT "geo_site_crawl_items_outcome_check" CHECK ("geo_site_crawl_items"."outcome" is null or "geo_site_crawl_items"."outcome" in ('NEW_VERSION', 'UNCHANGED', 'DUPLICATE', 'REDIRECTED', 'GONE', 'AUTH_REQUIRED', 'CLIENT_ERROR', 'SERVER_ERROR', 'NETWORK_ERROR', 'REDIRECT_BLOCKED', 'ADDRESS_BLOCKED', 'MIME_REJECTED', 'TOO_LARGE', 'ROBOTS_DISALLOWED', 'OUT_OF_SCOPE', 'NOFOLLOW', 'BUDGET_EXCEEDED', 'ASSET_RECORDED', 'ASSET_STORED', 'CIRCUIT_OPEN'))
);
--> statement-breakpoint
ALTER TABLE "geo_site_crawl_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "geo_site_host_throttle" (
	"host" text PRIMARY KEY NOT NULL,
	"holder" text,
	"lease_until" timestamp with time zone,
	"next_allowed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"breaker_open_until" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "geo_site_host_throttle" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "geo_site_profile_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"site_source_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"profile" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "geo_site_profile_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "geo_site_qa_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"sample_id" uuid NOT NULL,
	"page_version_id" uuid NOT NULL,
	"field_path" text NOT NULL,
	"extracted_value" text,
	"verdict" text,
	"note" text,
	"reviewer_id" text,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "geo_site_qa_items_verdict_check" CHECK ("geo_site_qa_items"."verdict" is null or "geo_site_qa_items"."verdict" in ('CORRECT', 'INCORRECT', 'NOT_APPLICABLE'))
);
--> statement-breakpoint
ALTER TABLE "geo_site_qa_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "geo_site_qa_samples" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"site_source_id" uuid NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"population" integer NOT NULL,
	"sample_size" integer NOT NULL,
	"seed" text NOT NULL,
	"created_by" text NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "geo_site_qa_samples_status_check" CHECK ("geo_site_qa_samples"."status" in ('OPEN', 'COMPLETED'))
);
--> statement-breakpoint
ALTER TABLE "geo_site_qa_samples" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "geo_assertion_reviews" DROP CONSTRAINT "geo_assertion_reviews_decision_check";--> statement-breakpoint
ALTER TABLE "geo_observations" DROP CONSTRAINT "geo_observations_status_check";--> statement-breakpoint
ALTER TABLE "geo_sampling_attempts" DROP CONSTRAINT "geo_sampling_attempts_status_check";--> statement-breakpoint
ALTER TABLE "geo_sampling_runs" DROP CONSTRAINT "geo_sampling_runs_status_check";--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "two_factor_enabled" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "geo_alerts" ADD COLUMN "notified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "geo_brand_entities" ADD COLUMN "fact_status" text DEFAULT 'UNVERIFIED' NOT NULL;--> statement-breakpoint
ALTER TABLE "geo_brand_entities" ADD COLUMN "fact_notes" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "geo_dictionary_versions" ADD COLUMN "changes" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "geo_dictionary_versions" ADD COLUMN "changed_entity_ids" uuid[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "geo_evaluations" ADD COLUMN "citation_attribution" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "geo_evaluations" ADD COLUMN "signals" jsonb;--> statement-breakpoint
ALTER TABLE "geo_evaluations" ADD COLUMN "review_reasons" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "geo_evaluations" ADD COLUMN "review_priority" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "geo_generated_reports" ADD COLUMN "title" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "geo_generated_reports" ADD COLUMN "review_status" text DEFAULT 'PENDING' NOT NULL;--> statement-breakpoint
ALTER TABLE "geo_generated_reports" ADD COLUMN "review_note" text;--> statement-breakpoint
ALTER TABLE "geo_knowledge_assertions" ADD COLUMN "frozen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "geo_knowledge_assertions" ADD COLUMN "frozen_by" text;--> statement-breakpoint
ALTER TABLE "geo_knowledge_assertions" ADD COLUMN "frozen_reason" text;--> statement-breakpoint
ALTER TABLE "geo_knowledge_assets" ADD COLUMN "file_name" text;--> statement-breakpoint
ALTER TABLE "geo_knowledge_assets" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "geo_knowledge_assets" ADD COLUMN "review_note" text;--> statement-breakpoint
ALTER TABLE "geo_knowledge_assets" ADD COLUMN "reviewed_by" text;--> statement-breakpoint
ALTER TABLE "geo_knowledge_assets" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "geo_observation_claims" ADD COLUMN "claim_kind" text DEFAULT 'NUMBER' NOT NULL;--> statement-breakpoint
ALTER TABLE "geo_observation_claims" ADD COLUMN "extracted_value" text;--> statement-breakpoint
ALTER TABLE "geo_observation_claims" ADD COLUMN "reference_value" text;--> statement-breakpoint
ALTER TABLE "geo_observation_claims" ADD COLUMN "match_status" text DEFAULT 'NO_REFERENCE' NOT NULL;--> statement-breakpoint
ALTER TABLE "geo_observation_claims" ADD COLUMN "review_note" text;--> statement-breakpoint
ALTER TABLE "geo_optimization_tasks" ADD COLUMN "launch_approval_ref" text;--> statement-breakpoint
ALTER TABLE "geo_optimization_tasks" ADD COLUMN "backup_plan" text;--> statement-breakpoint
ALTER TABLE "geo_optimization_tasks" ADD COLUMN "rollback_plan" text;--> statement-breakpoint
ALTER TABLE "geo_org_settings" ADD COLUMN "admin_mfa_required" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "geo_prompts" ADD COLUMN "source_note" text;--> statement-breakpoint
ALTER TABLE "geo_sampling_attempts" ADD COLUMN "target_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "geo_sampling_runs" ADD COLUMN "attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "geo_sampling_runs" ADD COLUMN "next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "geo_sampling_targets" ADD COLUMN "breaker_failure_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "geo_sampling_targets" ADD COLUMN "breaker_opened_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "geo_sampling_targets" ADD COLUMN "verified_by" text;--> statement-breakpoint
ALTER TABLE "geo_sampling_targets" ADD COLUMN "verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "geo_sampling_targets" ADD COLUMN "bootstrap_key" text;--> statement-breakpoint
ALTER TABLE "geo_site_audit_findings" ADD COLUMN "site_source_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "geo_site_audit_findings" ADD COLUMN "subject_key" text NOT NULL;--> statement-breakpoint
ALTER TABLE "geo_site_audit_findings" ADD COLUMN "rule_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "geo_site_audit_findings" ADD COLUMN "priority" text DEFAULT 'P2' NOT NULL;--> statement-breakpoint
ALTER TABLE "geo_site_audit_findings" ADD COLUMN "page_version_id" uuid;--> statement-breakpoint
ALTER TABLE "geo_site_audit_findings" ADD COLUMN "last_run_id" uuid;--> statement-breakpoint
ALTER TABLE "geo_site_audit_findings" ADD COLUMN "first_seen_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "geo_site_audit_findings" ADD COLUMN "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "geo_site_audit_findings" ADD COLUMN "resolved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "geo_site_audit_findings" ADD COLUMN "resolved_run_id" uuid;--> statement-breakpoint
ALTER TABLE "geo_site_audit_findings" ADD COLUMN "status_note" text;--> statement-breakpoint
ALTER TABLE "geo_site_audit_findings" ADD COLUMN "triaged_by" text;--> statement-breakpoint
ALTER TABLE "geo_site_audit_findings" ADD COLUMN "triaged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "geo_site_audit_runs" ADD COLUMN "crawl_run_id" uuid;--> statement-breakpoint
ALTER TABLE "geo_site_audit_runs" ADD COLUMN "site_checks" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "geo_site_crawl_runs" ADD COLUMN "config" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "geo_site_sources" ADD COLUMN "key_urls" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "two_factor" ADD CONSTRAINT "two_factor_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_admin_requests" ADD CONSTRAINT "geo_admin_requests_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_content_reviews" ADD CONSTRAINT "geo_content_reviews_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_content_reviews" ADD CONSTRAINT "geo_content_reviews_item_id_geo_content_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."geo_content_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_site_crawl_items" ADD CONSTRAINT "geo_site_crawl_items_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_site_crawl_items" ADD CONSTRAINT "geo_site_crawl_items_run_id_geo_site_crawl_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."geo_site_crawl_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_site_crawl_items" ADD CONSTRAINT "geo_site_crawl_items_page_id_geo_site_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."geo_site_pages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_site_crawl_items" ADD CONSTRAINT "geo_site_crawl_items_version_id_geo_site_page_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."geo_site_page_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_site_profile_versions" ADD CONSTRAINT "geo_site_profile_versions_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_site_profile_versions" ADD CONSTRAINT "geo_site_profile_versions_site_source_id_geo_site_sources_id_fk" FOREIGN KEY ("site_source_id") REFERENCES "public"."geo_site_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_site_qa_items" ADD CONSTRAINT "geo_site_qa_items_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_site_qa_items" ADD CONSTRAINT "geo_site_qa_items_sample_id_geo_site_qa_samples_id_fk" FOREIGN KEY ("sample_id") REFERENCES "public"."geo_site_qa_samples"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_site_qa_items" ADD CONSTRAINT "geo_site_qa_items_page_version_id_geo_site_page_versions_id_fk" FOREIGN KEY ("page_version_id") REFERENCES "public"."geo_site_page_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_site_qa_samples" ADD CONSTRAINT "geo_site_qa_samples_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_site_qa_samples" ADD CONSTRAINT "geo_site_qa_samples_site_source_id_geo_site_sources_id_fk" FOREIGN KEY ("site_source_id") REFERENCES "public"."geo_site_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "twoFactor_secret_idx" ON "two_factor" USING btree ("secret");--> statement-breakpoint
CREATE INDEX "twoFactor_userId_idx" ON "two_factor" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "geo_admin_requests_org_kind_pending_idx" ON "geo_admin_requests" USING btree ("organization_id","kind") WHERE "geo_admin_requests"."status" = 'PENDING';--> statement-breakpoint
CREATE INDEX "geo_admin_requests_org_created_idx" ON "geo_admin_requests" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "geo_backup_runs_kind_finished_idx" ON "geo_backup_runs" USING btree ("kind","finished_at");--> statement-breakpoint
CREATE INDEX "geo_content_reviews_item_created_idx" ON "geo_content_reviews" USING btree ("item_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "geo_site_crawl_items_run_url_idx" ON "geo_site_crawl_items" USING btree ("run_id","url");--> statement-breakpoint
CREATE INDEX "geo_site_crawl_items_run_status_idx" ON "geo_site_crawl_items" USING btree ("run_id","status","priority","depth");--> statement-breakpoint
CREATE INDEX "geo_site_crawl_items_pending_parse_idx" ON "geo_site_crawl_items" USING btree ("organization_id","updated_at") WHERE "geo_site_crawl_items"."outcome" in ('NEW_VERSION', 'ASSET_STORED') and "geo_site_crawl_items"."version_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "geo_site_profile_versions_source_version_idx" ON "geo_site_profile_versions" USING btree ("site_source_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "geo_site_qa_items_sample_version_field_idx" ON "geo_site_qa_items" USING btree ("sample_id","page_version_id","field_path");--> statement-breakpoint
CREATE INDEX "geo_site_qa_samples_source_created_idx" ON "geo_site_qa_samples" USING btree ("site_source_id","created_at");--> statement-breakpoint
ALTER TABLE "geo_sampling_attempts" ADD CONSTRAINT "geo_sampling_attempts_target_id_geo_sampling_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."geo_sampling_targets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_site_audit_findings" ADD CONSTRAINT "geo_site_audit_findings_site_source_id_geo_site_sources_id_fk" FOREIGN KEY ("site_source_id") REFERENCES "public"."geo_site_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_site_audit_findings" ADD CONSTRAINT "geo_site_audit_findings_page_version_id_geo_site_page_versions_id_fk" FOREIGN KEY ("page_version_id") REFERENCES "public"."geo_site_page_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_site_audit_findings" ADD CONSTRAINT "geo_site_audit_findings_last_run_id_geo_site_audit_runs_id_fk" FOREIGN KEY ("last_run_id") REFERENCES "public"."geo_site_audit_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_site_audit_findings" ADD CONSTRAINT "geo_site_audit_findings_resolved_run_id_geo_site_audit_runs_id_fk" FOREIGN KEY ("resolved_run_id") REFERENCES "public"."geo_site_audit_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_site_audit_runs" ADD CONSTRAINT "geo_site_audit_runs_crawl_run_id_geo_site_crawl_runs_id_fk" FOREIGN KEY ("crawl_run_id") REFERENCES "public"."geo_site_crawl_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "geo_evaluations_review_pool_idx" ON "geo_evaluations" USING btree ("organization_id","review_priority","created_at") WHERE "geo_evaluations"."is_current" = true and "geo_evaluations"."review_status" = 'PENDING_REVIEW';--> statement-breakpoint
CREATE INDEX "geo_sampling_attempts_target_started_idx" ON "geo_sampling_attempts" USING btree ("target_id","started_at");--> statement-breakpoint
CREATE INDEX "geo_sampling_runs_status_due_idx" ON "geo_sampling_runs" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "geo_sampling_targets_org_bootstrap_key_idx" ON "geo_sampling_targets" USING btree ("organization_id","bootstrap_key");--> statement-breakpoint
CREATE UNIQUE INDEX "geo_site_audit_findings_subject_idx" ON "geo_site_audit_findings" USING btree ("site_source_id","rule_id","subject_key");--> statement-breakpoint
CREATE INDEX "geo_site_audit_findings_version_idx" ON "geo_site_audit_findings" USING btree ("page_version_id");--> statement-breakpoint
ALTER TABLE "geo_assertion_reviews" ADD CONSTRAINT "geo_assertion_reviews_decision_check" CHECK ("geo_assertion_reviews"."decision" in ('APPROVE', 'REJECT', 'REQUEST_EVIDENCE', 'INVALIDATE', 'FREEZE', 'UNFREEZE'));--> statement-breakpoint
ALTER TABLE "geo_brand_entities" ADD CONSTRAINT "geo_brand_entities_fact_status_check" CHECK ("geo_brand_entities"."fact_status" in ('UNVERIFIED', 'PENDING_REVIEW', 'APPROVED', 'REJECTED'));--> statement-breakpoint
ALTER TABLE "geo_evaluations" ADD CONSTRAINT "geo_evaluations_review_reasons_check" CHECK ("geo_evaluations"."review_reasons" <@ array['LLM_DISAGREES', 'LOW_CONFIDENCE', 'HIGH_PRIORITY_PROMPT', 'TECHNICAL_CLAIM', 'CLAIM_MISMATCH', 'RULES_ONLY_JUDGEMENT']::text[]);--> statement-breakpoint
ALTER TABLE "geo_generated_reports" ADD CONSTRAINT "geo_generated_reports_review_status_check" CHECK ("geo_generated_reports"."review_status" in ('PENDING', 'APPROVED', 'REJECTED'));--> statement-breakpoint
ALTER TABLE "geo_observation_claims" ADD CONSTRAINT "geo_observation_claims_kind_check" CHECK ("geo_observation_claims"."claim_kind" in ('NUMBER', 'MODEL', 'CERTIFICATE'));--> statement-breakpoint
ALTER TABLE "geo_observation_claims" ADD CONSTRAINT "geo_observation_claims_match_check" CHECK ("geo_observation_claims"."match_status" in ('MATCHED', 'MISMATCH', 'NO_REFERENCE'));--> statement-breakpoint
ALTER TABLE "geo_observations" ADD CONSTRAINT "geo_observations_status_check" CHECK ("geo_observations"."status" in ('VALID', 'PARTIAL', 'UNAVAILABLE', 'NEEDS_MANUAL', 'FAILED', 'RATE_LIMITED', 'TIMEOUT', 'NETWORK_ERROR', 'CAPTCHA'));--> statement-breakpoint
ALTER TABLE "geo_sampling_attempts" ADD CONSTRAINT "geo_sampling_attempts_status_check" CHECK ("geo_sampling_attempts"."status" in ('RUNNING', 'VALID', 'PARTIAL', 'UNAVAILABLE', 'NEEDS_MANUAL', 'FAILED', 'RATE_LIMITED', 'TIMEOUT', 'NETWORK_ERROR', 'CAPTCHA'));--> statement-breakpoint
ALTER TABLE "geo_sampling_runs" ADD CONSTRAINT "geo_sampling_runs_status_check" CHECK ("geo_sampling_runs"."status" in ('PLANNED', 'RUNNING', 'VALID', 'PARTIAL', 'UNAVAILABLE', 'NEEDS_MANUAL', 'FAILED', 'RATE_LIMITED', 'TIMEOUT', 'NETWORK_ERROR', 'CAPTCHA'));--> statement-breakpoint
ALTER TABLE "geo_site_audit_findings" ADD CONSTRAINT "geo_site_audit_findings_priority_check" CHECK ("geo_site_audit_findings"."priority" in ('P0', 'P1', 'P2', 'P3'));--> statement-breakpoint
CREATE TRIGGER "geo_content_reviews_append_only" BEFORE UPDATE OR DELETE ON "geo_content_reviews"
	FOR EACH ROW EXECUTE FUNCTION "geo_append_only"();--> statement-breakpoint
CREATE TRIGGER "geo_prompt_revisions_append_only" BEFORE UPDATE OR DELETE ON "geo_prompt_revisions"
	FOR EACH ROW EXECUTE FUNCTION "geo_append_only"();--> statement-breakpoint
CREATE FUNCTION "geo_frozen_prompt_set_items"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	set_status text;
BEGIN
	-- A draft set's items may be rewritten; once the set is FROZEN they are fixed. As with
	-- geo_append_only, only the retention purge may delete, and only inside a transaction
	-- that set geo.retention_purge with SET LOCAL. The set row is locked FOR SHARE whatever
	-- its status, so an item write and a concurrent freeze of the same set serialize.
	IF TG_OP = 'DELETE' AND current_setting('geo.retention_purge', true) = 'on' THEN
		RETURN OLD;
	END IF;
	IF TG_OP IN ('UPDATE', 'DELETE') THEN
		SELECT "status" INTO set_status FROM "geo_prompt_sets" WHERE "id" = OLD."set_id" FOR SHARE;
		IF set_status = 'FROZEN' THEN
			RAISE EXCEPTION 'items of frozen prompt set % cannot change', OLD."set_id";
		END IF;
	END IF;
	IF TG_OP IN ('INSERT', 'UPDATE') THEN
		SELECT "status" INTO set_status FROM "geo_prompt_sets" WHERE "id" = NEW."set_id" FOR SHARE;
		IF set_status = 'FROZEN' THEN
			RAISE EXCEPTION 'items of frozen prompt set % cannot change', NEW."set_id";
		END IF;
	END IF;
	IF TG_OP = 'DELETE' THEN
		RETURN OLD;
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "geo_prompt_set_items_frozen" BEFORE INSERT OR UPDATE OR DELETE ON "geo_prompt_set_items"
	FOR EACH ROW EXECUTE FUNCTION "geo_frozen_prompt_set_items"();
