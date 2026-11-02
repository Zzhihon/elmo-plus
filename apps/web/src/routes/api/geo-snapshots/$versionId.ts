import { createFileRoute } from "@tanstack/react-router";
import { GeoError } from "@workspace/geo-domain";
import { requireGeoServerFnPrincipal } from "@/server/geo/context";
import { getSnapshotDownload } from "@/server/geo/site-core";

/**
 * Session-authenticated download of a stored page for the dashboard, which
 * cannot reach `/api/v1` with a cookie. The response is an attachment of an
 * inert type, never rendered here.
 */
export const Route = createFileRoute("/api/geo-snapshots/$versionId")({
	server: {
		handlers: {
			GET: async ({ request, params }) => {
				const organizationId = new URL(request.url).searchParams.get("organizationId");
				try {
					if (!organizationId) throw new GeoError("VALIDATION_ERROR", "缺少 organizationId");
					const principal = await requireGeoServerFnPrincipal(organizationId, "site.read_snapshot", request);
					return await getSnapshotDownload(principal, params.versionId);
				} catch (error) {
					if (error instanceof GeoError) {
						return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status });
					}
					throw error;
				}
			},
		},
	},
});
