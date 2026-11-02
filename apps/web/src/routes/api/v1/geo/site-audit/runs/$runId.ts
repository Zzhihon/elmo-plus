import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { createGeoApiHandler, withGeoMethodGuard } from "@/lib/api/geo-handler";
import { getSiteAuditRun } from "@/server/geo/site-audit-core";

const params = z.object({ runId: z.string().uuid() });

export const Route = createFileRoute("/api/v1/geo/site-audit/runs/$runId")({
	server: {
		handlers: withGeoMethodGuard({
			GET: createGeoApiHandler({
				permission: "site_audit.read",
				params,
				handle: async ({ principal, params }) => ({ data: await getSiteAuditRun(principal, params.runId) }),
			}),
		}),
	},
});
