import { createFileRoute } from "@tanstack/react-router";
import { createGeoApiHandler, geoPage, geoPaging, withGeoMethodGuard } from "@/lib/api/geo-handler";
import { findingFilterSchema, listSiteAuditFindings } from "@/server/geo/site-audit-core";

export const Route = createFileRoute("/api/v1/geo/site-audit/findings/")({
	server: {
		handlers: withGeoMethodGuard({
			GET: createGeoApiHandler({
				permission: "site_audit.read",
				query: findingFilterSchema.passthrough(),
				handle: async ({ principal, query, request }) => {
					const paging = geoPaging(request);
					const { rows, total } = await listSiteAuditFindings(principal, query, paging);
					return geoPage(rows, total, paging);
				},
			}),
		}),
	},
});
