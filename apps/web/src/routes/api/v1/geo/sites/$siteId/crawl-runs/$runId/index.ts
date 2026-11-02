import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { createGeoApiHandler, withGeoMethodGuard } from "@/lib/api/geo-handler";
import { getCrawlRun } from "@/server/geo/site-core";

export const Route = createFileRoute("/api/v1/geo/sites/$siteId/crawl-runs/$runId/")({
	server: {
		handlers: withGeoMethodGuard({
			GET: createGeoApiHandler({
				permission: "site.read",
				params: z.object({ siteId: z.string().uuid(), runId: z.string().uuid() }),
				handle: async ({ principal, params }) => ({ data: await getCrawlRun(principal, params.siteId, params.runId) }),
			}),
		}),
	},
});
