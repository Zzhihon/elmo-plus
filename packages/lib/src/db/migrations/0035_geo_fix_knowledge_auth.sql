CREATE TABLE "geo_api_key_owners" (
	"key_id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "geo_api_key_owners" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "geo_session_factors" (
	"session_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"factor" text NOT NULL,
	"verified_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "geo_session_factors_factor_check" CHECK ("geo_session_factors"."factor" in ('TWO_FACTOR', 'SSO'))
);
--> statement-breakpoint
ALTER TABLE "geo_session_factors" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "geo_task_events" ADD COLUMN "owner_id" text;--> statement-breakpoint
ALTER TABLE "geo_api_key_owners" ADD CONSTRAINT "geo_api_key_owners_key_id_apikey_id_fk" FOREIGN KEY ("key_id") REFERENCES "public"."apikey"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_api_key_owners" ADD CONSTRAINT "geo_api_key_owners_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_session_factors" ADD CONSTRAINT "geo_session_factors_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "geo_api_key_owners_org_idx" ON "geo_api_key_owners" USING btree ("organization_id");