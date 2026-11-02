import { createFileRoute } from "@tanstack/react-router";
import { createGeoApiHandler, geoPage, geoPaging, withGeoMethodGuard } from "@/lib/api/geo-handler";
import { listObservations, observationListQuerySchema } from "@/server/geo/observations-core";

export const Route = createFileRoute("/api/v1/geo/observations/")({
	server: {
		handlers: withGeoMethodGuard({
			GET: createGeoApiHandler({
				permission: "observation.read",
				query: observationListQuerySchema,
				handle: async ({ query, request, principal }) => {
					const paging = geoPaging(request);
					const { rows, total } = await listObservations(principal, query, paging);
					return geoPage(rows, total, paging);
				},
			}),
		}),
	},
});
