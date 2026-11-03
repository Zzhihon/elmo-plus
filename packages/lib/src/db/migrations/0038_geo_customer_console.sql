CREATE TABLE "geo_citation_classifications" (
	"url" text PRIMARY KEY NOT NULL,
	"domain" text NOT NULL,
	"content_type" text NOT NULL,
	"title" text,
	"classifier" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "geo_citation_classifications_type_check" CHECK ("geo_citation_classifications"."content_type" in ('PRODUCT_SPEC', 'CASE_STUDY', 'QUALIFICATION', 'COMPANY_PROFILE', 'NEWS', 'SELECTION_GUIDE', 'DIRECTORY_LISTING', 'QA_COMMUNITY', 'MEDIA_ARTICLE', 'OTHER'))
);
--> statement-breakpoint
ALTER TABLE "geo_citation_classifications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "geo_competitor_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"aliases" text[] DEFAULT '{}' NOT NULL,
	"domains" text[] DEFAULT '{}' NOT NULL,
	"mention_count" integer DEFAULT 0 NOT NULL,
	"observation_count" integer DEFAULT 0 NOT NULL,
	"platforms" text[] DEFAULT '{}' NOT NULL,
	"sample_observation_ids" uuid[] DEFAULT '{}' NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"brand_entity_id" uuid,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "geo_competitor_candidates_status_check" CHECK ("geo_competitor_candidates"."status" in ('PENDING', 'ACCEPTED', 'DISMISSED'))
);
--> statement-breakpoint
ALTER TABLE "geo_competitor_candidates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "geo_dashboard_layouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"cards" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "geo_dashboard_layouts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "geo_recommendations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"kind" text NOT NULL,
	"subject_key" text NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"content_type" text,
	"priority" text DEFAULT 'P2' NOT NULL,
	"impact_score" double precision DEFAULT 0 NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"task_id" uuid,
	"generator_version" text NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "geo_recommendations_kind_check" CHECK ("geo_recommendations"."kind" in ('CONTENT_GAP', 'SITE_FIX', 'THIRD_PARTY_CHANNEL', 'FACT_CORRECTION')),
	CONSTRAINT "geo_recommendations_status_check" CHECK ("geo_recommendations"."status" in ('OPEN', 'DISMISSED', 'CONVERTED')),
	CONSTRAINT "geo_recommendations_priority_check" CHECK ("geo_recommendations"."priority" in ('P0', 'P1', 'P2', 'P3')),
	CONSTRAINT "geo_recommendations_content_type_check" CHECK ("geo_recommendations"."content_type" is null or "geo_recommendations"."content_type" in ('PRODUCT_SPEC', 'CASE_STUDY', 'QUALIFICATION', 'COMPANY_PROFILE', 'NEWS', 'SELECTION_GUIDE', 'DIRECTORY_LISTING', 'QA_COMMUNITY', 'MEDIA_ARTICLE', 'OTHER'))
);
--> statement-breakpoint
ALTER TABLE "geo_recommendations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "geo_simulation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"question" text NOT NULL,
	"platform" text NOT NULL,
	"surface_mode" text NOT NULL,
	"target_id" uuid,
	"status" text DEFAULT 'RUNNING' NOT NULL,
	"answer_text" text,
	"citations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"mentions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"model_version" text,
	"error_code" text,
	"error_message" text,
	"latency_ms" integer,
	"saved_observation_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "geo_simulation_runs_platform_check" CHECK ("geo_simulation_runs"."platform" in ('doubao', 'deepseek', 'yuanbao', 'qwen')),
	CONSTRAINT "geo_simulation_runs_surface_mode_check" CHECK ("geo_simulation_runs"."surface_mode" in ('LIVE_SURFACE', 'MODEL_API', 'MANUAL_EVIDENCE')),
	CONSTRAINT "geo_simulation_runs_status_check" CHECK ("geo_simulation_runs"."status" in ('RUNNING', 'SUCCEEDED', 'FAILED'))
);
--> statement-breakpoint
ALTER TABLE "geo_simulation_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "geo_optimization_tasks" DROP CONSTRAINT "geo_optimization_tasks_source_kind_check";--> statement-breakpoint
ALTER TABLE "geo_competitor_candidates" ADD CONSTRAINT "geo_competitor_candidates_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_competitor_candidates" ADD CONSTRAINT "geo_competitor_candidates_brand_entity_id_geo_brand_entities_id_fk" FOREIGN KEY ("brand_entity_id") REFERENCES "public"."geo_brand_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_dashboard_layouts" ADD CONSTRAINT "geo_dashboard_layouts_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_dashboard_layouts" ADD CONSTRAINT "geo_dashboard_layouts_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_recommendations" ADD CONSTRAINT "geo_recommendations_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_recommendations" ADD CONSTRAINT "geo_recommendations_task_id_geo_optimization_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."geo_optimization_tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_simulation_runs" ADD CONSTRAINT "geo_simulation_runs_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_simulation_runs" ADD CONSTRAINT "geo_simulation_runs_target_id_geo_sampling_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."geo_sampling_targets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_simulation_runs" ADD CONSTRAINT "geo_simulation_runs_saved_observation_id_geo_observations_id_fk" FOREIGN KEY ("saved_observation_id") REFERENCES "public"."geo_observations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "geo_citation_classifications_domain_idx" ON "geo_citation_classifications" USING btree ("domain");--> statement-breakpoint
CREATE UNIQUE INDEX "geo_competitor_candidates_org_name_idx" ON "geo_competitor_candidates" USING btree ("organization_id","normalized_name");--> statement-breakpoint
CREATE INDEX "geo_competitor_candidates_org_status_idx" ON "geo_competitor_candidates" USING btree ("organization_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "geo_dashboard_layouts_org_user_idx" ON "geo_dashboard_layouts" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "geo_recommendations_org_subject_idx" ON "geo_recommendations" USING btree ("organization_id","kind","subject_key");--> statement-breakpoint
CREATE INDEX "geo_recommendations_org_status_idx" ON "geo_recommendations" USING btree ("organization_id","status","impact_score");--> statement-breakpoint
CREATE INDEX "geo_simulation_runs_org_created_idx" ON "geo_simulation_runs" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "geo_simulation_runs_org_user_created_idx" ON "geo_simulation_runs" USING btree ("organization_id","user_id","created_at");--> statement-breakpoint
ALTER TABLE "geo_optimization_tasks" ADD CONSTRAINT "geo_optimization_tasks_source_kind_check" CHECK ("geo_optimization_tasks"."source_kind" in ('OBSERVATION', 'FINDING', 'ASSERTION', 'RECOMMENDATION', 'MANUAL'));