import { createFileRoute } from "@tanstack/react-router";
import { createGeoApiHandler, geoPage, geoPaging, withGeoMethodGuard } from "@/lib/api/geo-handler";
import { conflictFiltersSchema, listConflicts } from "@/server/geo/knowledge-core";

export const Route = createFileRoute("/api/v1/geo/knowledge-claims/conflicts/")({
	server: {
		handlers: withGeoMethodGuard({
			GET: createGeoApiHandler({
				permission: "knowledge.read",
				query: conflictFiltersSchema,
				handle: async ({ request, principal, query }) => {
					const paging = geoPaging(request);
					const { rows, total } = await listConflicts(principal, query, paging);
					return geoPage(rows, total, paging);
				},
			}),
		}),
	},
});
