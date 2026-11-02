import { createFileRoute } from "@tanstack/react-router";
import { requireGeoServerFnPrincipal } from "@/server/geo/context";
import { readObservationEvidence } from "@/server/geo/observations-core";
import { evidenceHeaders, geoRouteResponse } from "@/server/geo/observations-routes";

export const Route = createFileRoute("/api/geo/$org/observations/$id/evidence")({
	server: {
		handlers: {
			GET: ({ request, params }) =>
				geoRouteResponse(request, async () => {
					const principal = await requireGeoServerFnPrincipal(params.org, "observation.read", request);
					const object = await readObservationEvidence(principal, params.id);
					return new Response(new Blob([object.body.slice()]), {
						headers: evidenceHeaders(object.contentType, object.name),
					});
				}),
		},
	},
});
