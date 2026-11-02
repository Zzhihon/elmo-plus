/**
 * /api/v1/geo/audit-logs — the organization's GEO audit trail, newest first.
 *
 * Needs `audit.read`, which only a platform administrator holds; API keys never do,
 * so through this API it answers FORBIDDEN by design.
 */
import { createFileRoute } from "@tanstack/react-router";
import { createGeoApiHandler, geoPage, geoPaging, withGeoMethodGuard } from "@/lib/api/geo-handler";
import { auditQuerySchema, listAuditLogs } from "@/server/geo/admin-core";

export const Route = createFileRoute("/api/v1/geo/audit-logs")({
	server: {
		handlers: withGeoMethodGuard({
			GET: createGeoApiHandler({
				permission: "audit.read",
				query: auditQuerySchema,
				handle: async ({ request, principal, query }) => {
					const paging = geoPaging(request);
					const { rows, total } = await listAuditLogs(principal, query, paging);
					return geoPage(rows, total, paging);
				},
			}),
		}),
	},
});
