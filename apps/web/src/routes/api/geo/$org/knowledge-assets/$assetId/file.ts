import { createFileRoute } from "@tanstack/react-router";
import { GeoError } from "@workspace/geo-domain";
import { requireGeoServerFnPrincipal } from "@/server/geo/context";
import { downloadKnowledgeAsset } from "@/server/geo/knowledge-assets-core";
import { geoRouteResponse } from "@/server/geo/observations-routes";

export const Route = createFileRoute("/api/geo/$org/knowledge-assets/$assetId/file")({
	server: {
		handlers: {
			GET: ({ request, params }) =>
				geoRouteResponse(request, async () => {
					if (!/^[0-9a-f-]{36}$/i.test(params.assetId)) throw new GeoError("NOT_FOUND", "资料不存在");
					const principal = await requireGeoServerFnPrincipal(params.org, "knowledge.read", request);
					return downloadKnowledgeAsset(principal, params.assetId);
				}),
		},
	},
});
