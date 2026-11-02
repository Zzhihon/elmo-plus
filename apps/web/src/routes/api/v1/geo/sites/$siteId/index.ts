import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { createGeoApiHandler, withGeoMethodGuard } from "@/lib/api/geo-handler";
import { getSite, siteSourcePatchSchema, updateSite } from "@/server/geo/site-core";

const params = z.object({ siteId: z.string().uuid() });

export const Route = createFileRoute("/api/v1/geo/sites/$siteId/")({
	server: {
		handlers: withGeoMethodGuard({
			GET: createGeoApiHandler({
				permission: "site.read",
				params,
				handle: async ({ principal, params }) => ({ data: await getSite(principal, params.siteId) }),
			}),
			PATCH: createGeoApiHandler({
				permission: "site.manage",
				params,
				body: siteSourcePatchSchema,
				idempotent: true,
				handle: async ({ principal, params, body }) => ({ data: await updateSite(principal, params.siteId, body) }),
			}),
		}),
	},
});
