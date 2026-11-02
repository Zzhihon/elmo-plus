import { createFileRoute } from "@tanstack/react-router";
import { createGeoApiHandler, geoPage, geoPaging, withGeoMethodGuard } from "@/lib/api/geo-handler";
import {
	auditRunCreateSchema,
	auditRunFilterSchema,
	listSiteAuditRuns,
	startSiteAudit,
} from "@/server/geo/site-audit-core";

export const Route = createFileRoute("/api/v1/geo/site-audit/runs/")({
	server: {
		handlers: withGeoMethodGuard({
			GET: createGeoApiHandler({
				permission: "site_audit.read",
				query: auditRunFilterSchema.passthrough(),
				handle: async ({ principal, query, request }) => {
					const paging = geoPaging(request);
					const { rows, total } = await listSiteAuditRuns(principal, query, paging);
					return geoPage(rows, total, paging);
				},
			}),
			POST: createGeoApiHandler({
				permission: "site_audit.run",
				body: auditRunCreateSchema,
				idempotent: true,
				handle: async ({ principal, body, request }) => {
					const result = await startSiteAudit(principal, {
						...body,
						idempotencyKey: request.headers.get("Idempotency-Key"),
					});
					return Response.json({ data: result }, { status: result.created ? 202 : 200 });
				},
			}),
		}),
	},
});
