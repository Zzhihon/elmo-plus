CREATE TABLE "geo_evidence_uploads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"object_key" text NOT NULL,
	"sha256" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"uploaded_by" text NOT NULL,
	"import_batch_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "geo_evidence_uploads" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "geo_generated_reports" ADD COLUMN "pdf_unavailable_reason" text;--> statement-breakpoint
ALTER TABLE "geo_generated_reports" ADD COLUMN "claim_token" text;--> statement-breakpoint
ALTER TABLE "geo_sampling_batches" ADD COLUMN "includes_extended" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "geo_evidence_uploads" ADD CONSTRAINT "geo_evidence_uploads_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "geo_evidence_uploads_org_key_idx" ON "geo_evidence_uploads" USING btree ("organization_id","object_key");--> statement-breakpoint
CREATE INDEX "geo_evidence_uploads_org_pending_idx" ON "geo_evidence_uploads" USING btree ("organization_id","created_at") WHERE import_batch_id is null;