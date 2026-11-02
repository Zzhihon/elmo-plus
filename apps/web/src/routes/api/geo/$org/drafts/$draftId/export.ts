import { createFileRoute } from "@tanstack/react-router";
import { GeoError } from "@workspace/geo-domain";
import { requireGeoServerFnPrincipal } from "@/server/geo/context";
import { exportDraft } from "@/server/geo/drafts-core";
import { geoRouteResponse } from "@/server/geo/observations-routes";

export const Route = createFileRoute("/api/geo/$org/drafts/$draftId/export")({
	server: {
		handlers: {
			GET: ({ request, params }) =>
				geoRouteResponse(request, async () => {
					if (!/^[0-9a-f-]{36}$/i.test(params.draftId)) throw new GeoError("NOT_FOUND", "草稿不存在");
					const format = new URL(request.url).searchParams.get("format") === "html" ? "html" : "md";
					const principal = await requireGeoServerFnPrincipal(params.org, "content.publish", request);
					return exportDraft(principal, params.draftId, format);
				}),
		},
	},
});
