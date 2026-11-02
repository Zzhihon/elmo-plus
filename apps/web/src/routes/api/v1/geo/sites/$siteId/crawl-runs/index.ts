import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { createGeoApiHandler, geoPage, geoPaging, withGeoMethodGuard } from "@/lib/api/geo-handler";
import { crawlRunCreateSchema, listCrawlRuns, startCrawl } from "@/server/geo/site-core";

const params = z.object({ siteId: z.string().uuid() });

export const Route = createFileRoute("/api/v1/geo/sites/$siteId/crawl-runs/")({
	server: {
		handlers: withGeoMethodGuard({
			GET: createGeoApiHandler({
				permission: "site.read",
				params,
				handle: async ({ principal, params, request }) => {
					const paging = geoPaging(request);
					const { rows, total } = await listCrawlRuns(principal, params.siteId, paging);
					return geoPage(rows, total, paging);
				},
			}),
			POST: createGeoApiHandler({
				permission: "site.crawl",
				params,
				body: crawlRunCreateSchema,
				idempotent: true,
				handle: async ({ principal, params, body, request }) => {
					const result = await startCrawl(principal, params.siteId, {
						...body,
						idempotencyKey: request.headers.get("Idempotency-Key"),
					});
					return Response.json({ data: result }, { status: result.created ? 202 : 200 });
				},
			}),
		}),
	},
});
