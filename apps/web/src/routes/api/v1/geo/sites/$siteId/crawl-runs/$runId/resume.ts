import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { createGeoApiHandler, withGeoMethodGuard } from "@/lib/api/geo-handler";
import { setRunPaused } from "@/server/geo/site-core";

export const Route = createFileRoute("/api/v1/geo/sites/$siteId/crawl-runs/$runId/resume")({
	server: {
		handlers: withGeoMethodGuard({
			POST: createGeoApiHandler({
				permission: "site.crawl",
				params: z.object({ siteId: z.string().uuid(), runId: z.string().uuid() }),
				idempotent: true,
				handle: async ({ principal, params }) => ({
					data: await setRunPaused(principal, params.siteId, params.runId, false),
				}),
			}),
		}),
	},
});
