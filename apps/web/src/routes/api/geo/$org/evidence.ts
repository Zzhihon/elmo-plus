import { createFileRoute } from "@tanstack/react-router";
import { GeoError } from "@workspace/geo-domain";
import { requireGeoServerFnPrincipal } from "@/server/geo/context";
import { uploadEvidenceFile } from "@/server/geo/observations-import-core";
import { assertSameOrigin, geoRouteResponse } from "@/server/geo/observations-routes";

export const Route = createFileRoute("/api/geo/$org/evidence")({
	server: {
		handlers: {
			POST: ({ request, params }) =>
				geoRouteResponse(request, async () => {
					assertSameOrigin(request);
					const principal = await requireGeoServerFnPrincipal(params.org, "evidence.import", request);
					const form = await request.formData().catch(() => null);
					const file = form?.get("file");
					if (!(file instanceof File)) throw new GeoError("VALIDATION_ERROR", "请选择要上传的文件");
					return Response.json({ data: await uploadEvidenceFile(principal, file) }, { status: 201 });
				}),
		},
	},
});
