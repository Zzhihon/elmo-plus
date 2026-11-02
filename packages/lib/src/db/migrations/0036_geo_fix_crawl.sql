ALTER TABLE "geo_site_crawl_items" DROP CONSTRAINT "geo_site_crawl_items_outcome_check";--> statement-breakpoint
ALTER TABLE "geo_site_crawl_runs" ADD COLUMN "robots" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "geo_site_crawl_runs" ADD COLUMN "lease_holder" text;--> statement-breakpoint
ALTER TABLE "geo_site_crawl_runs" ADD COLUMN "lease_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "geo_site_page_versions" ADD COLUMN "fetched_url" text;--> statement-breakpoint
ALTER TABLE "geo_site_pages" ADD COLUMN "current_content_hash" text;--> statement-breakpoint
ALTER TABLE "geo_site_pages" ADD COLUMN "current_version_id" uuid;--> statement-breakpoint
ALTER TABLE "geo_site_pages" ADD CONSTRAINT "geo_site_pages_current_version_id_geo_site_page_versions_id_fk" FOREIGN KEY ("current_version_id") REFERENCES "public"."geo_site_page_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
UPDATE "geo_site_crawl_runs" AS older
SET "status" = 'CANCELLED', "finished_at" = now(), "error_summary" = '同一站点存在更新的进行中任务，本任务已取消'
WHERE older."status" IN ('QUEUED', 'RUNNING', 'PAUSED')
	AND EXISTS (
		SELECT 1 FROM "geo_site_crawl_runs" AS newer
		WHERE newer."site_source_id" = older."site_source_id"
			AND newer."status" IN ('QUEUED', 'RUNNING', 'PAUSED')
			AND (newer."created_at", newer."id") > (older."created_at", older."id")
	);--> statement-breakpoint
CREATE UNIQUE INDEX "geo_site_crawl_runs_source_active_idx" ON "geo_site_crawl_runs" USING btree ("site_source_id") WHERE "geo_site_crawl_runs"."status" in ('QUEUED', 'RUNNING', 'PAUSED');--> statement-breakpoint
ALTER TABLE "geo_site_crawl_items" ADD CONSTRAINT "geo_site_crawl_items_outcome_check" CHECK ("geo_site_crawl_items"."outcome" is null or "geo_site_crawl_items"."outcome" in ('NEW_VERSION', 'UNCHANGED', 'REVERTED', 'DUPLICATE', 'REDIRECTED', 'GONE', 'AUTH_REQUIRED', 'CLIENT_ERROR', 'SERVER_ERROR', 'NETWORK_ERROR', 'REDIRECT_BLOCKED', 'ADDRESS_BLOCKED', 'MIME_REJECTED', 'TOO_LARGE', 'ROBOTS_DISALLOWED', 'OUT_OF_SCOPE', 'NOFOLLOW', 'BUDGET_EXCEEDED', 'ASSET_RECORDED', 'ASSET_STORED', 'CIRCUIT_OPEN'));--> statement-breakpoint
UPDATE "geo_site_pages" AS page
SET "current_version_id" = current_version."id", "current_content_hash" = current_version."content_hash"
FROM "geo_site_page_versions" AS current_version
WHERE current_version."id" = COALESCE(
	(
		SELECT item."version_id" FROM "geo_site_crawl_items" AS item
		WHERE item."page_id" = page."id" AND item."version_id" IS NOT NULL
		ORDER BY item."fetched_at" DESC NULLS LAST, item."created_at" DESC
		LIMIT 1
	),
	(
		SELECT version."id" FROM "geo_site_page_versions" AS version
		WHERE version."page_id" = page."id"
		ORDER BY version."fetched_at" DESC, version."created_at" DESC
		LIMIT 1
	)
);
