import { createFileRoute } from "@tanstack/react-router";
import { GeoError } from "@workspace/geo-domain";
import { requireGeoServerFnPrincipal } from "@/server/geo/context";
import { geoRouteResponse } from "@/server/geo/observations-routes";
import { exportReport, reportDownloadResponse, reportFormatSchema } from "@/server/geo/reports-core";

/** Browser downloads of a report's PDF or CSV, behind the session; every download lands in the export history. */
export const Route = createFileRoute("/api/geo/$org/reports/$id/$format")({
	server: {
		handlers: {
			GET: ({ request, params }) =>
				geoRouteResponse(request, async () => {
					const format = reportFormatSchema.safeParse(params.format);
					if (!format.success) throw new GeoError("NOT_FOUND", "不支持的导出格式");
					const principal = await requireGeoServerFnPrincipal(params.org, "report.read", request);
					return reportDownloadResponse(await exportReport(principal, params.id, format.data));
				}),
		},
	},
});
