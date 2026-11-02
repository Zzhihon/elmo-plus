import { createFileRoute } from "@tanstack/react-router";
import { db } from "@workspace/lib/db/db";
import { writeGeoAudit } from "@workspace/lib/geo/audit";
import { requireGeoServerFnPrincipal } from "@/server/geo/context";
import { exportObservation } from "@/server/geo/observations-core";
import { geoRouteResponse } from "@/server/geo/observations-routes";

export const Route = createFileRoute("/api/geo/$org/observations/$id/export")({
	server: {
		handlers: {
			GET: ({ request, params }) =>
				geoRouteResponse(request, async () => {
					const principal = await requireGeoServerFnPrincipal(params.org, "observation.read", request);
					const document = await exportObservation(principal, params.id);
					await db.transaction((tx) =>
						writeGeoAudit(tx, {
							principal,
							action: "observation.export",
							entityType: "observation",
							entityId: params.id,
						}),
					);
					return new Response(JSON.stringify(document, null, 2), {
						headers: {
							"Content-Type": "application/json; charset=utf-8",
							"Content-Disposition": `attachment; filename="observation-${params.id}.json"`,
							"Cache-Control": "private, no-store",
							"X-Content-Type-Options": "nosniff",
						},
					});
				}),
		},
	},
});
