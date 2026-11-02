import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { createGeoApiHandler, withGeoMethodGuard } from "@/lib/api/geo-handler";
import { findingPatchSchema, getSiteAuditFinding, updateSiteAuditFinding } from "@/server/geo/site-audit-core";

const params = z.object({ findingId: z.string().uuid() });

export const Route = createFileRoute("/api/v1/geo/site-audit/findings/$findingId/")({
	server: {
		handlers: withGeoMethodGuard({
			GET: createGeoApiHandler({
				permission: "site_audit.read",
				params,
				handle: async ({ principal, params }) => ({ data: await getSiteAuditFinding(principal, params.findingId) }),
			}),
			PATCH: createGeoApiHandler({
				permission: "site_audit.triage",
				params,
				body: findingPatchSchema,
				handle: async ({ principal, params, body }) => ({
					data: await updateSiteAuditFinding(principal, params.findingId, body),
				}),
			}),
		}),
	},
});
