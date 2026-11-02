import { createFileRoute } from "@tanstack/react-router";
import { requireGeoServerFnPrincipal } from "@/server/geo/context";
import { readAssetUpload, uploadKnowledgeAsset } from "@/server/geo/knowledge-assets-core";
import { assertSameOrigin, geoRouteResponse } from "@/server/geo/observations-routes";

export const Route = createFileRoute("/api/geo/$org/knowledge-assets/")({
	server: {
		handlers: {
			POST: ({ request, params }) =>
				geoRouteResponse(request, async () => {
					assertSameOrigin(request);
					const principal = await requireGeoServerFnPrincipal(params.org, "knowledge.write", request);
					const { file, metadata } = await readAssetUpload(request);
					const result = await uploadKnowledgeAsset(principal, file, metadata);
					return Response.json({ data: result }, { status: result.created ? 201 : 200 });
				}),
		},
	},
});
