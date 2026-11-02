import { createFileRoute } from "@tanstack/react-router";
import { createGeoApiHandler, geoPage, geoPaging, withGeoMethodGuard } from "@/lib/api/geo-handler";
import { listSitePages, sitePageFilterSchema } from "@/server/geo/site-core";

export const Route = createFileRoute("/api/v1/geo/site-pages/")({
	server: {
		handlers: withGeoMethodGuard({
			GET: createGeoApiHandler({
				permission: "site.read",
				query: sitePageFilterSchema.passthrough(),
				handle: async ({ principal, query, request }) => {
					const paging = geoPaging(request);
					const { rows, total } = await listSitePages(principal, query, paging);
					return geoPage(rows, total, paging);
				},
			}),
		}),
	},
});
