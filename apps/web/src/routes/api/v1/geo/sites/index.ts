import { createFileRoute } from "@tanstack/react-router";
import { createGeoApiHandler, withGeoMethodGuard } from "@/lib/api/geo-handler";
import { createSite, listSites, siteSourceCreateSchema } from "@/server/geo/site-core";

export const Route = createFileRoute("/api/v1/geo/sites/")({
	server: {
		handlers: withGeoMethodGuard({
			GET: createGeoApiHandler({
				permission: "site.read",
				handle: async ({ principal }) => ({ data: await listSites(principal) }),
			}),
			POST: createGeoApiHandler({
				permission: "site.manage",
				body: siteSourceCreateSchema,
				status: 201,
				idempotent: true,
				handle: async ({ principal, body }) => ({ data: await createSite(principal, body) }),
			}),
		}),
	},
});
