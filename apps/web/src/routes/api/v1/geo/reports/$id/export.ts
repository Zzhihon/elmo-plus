import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { createGeoApiHandler, withGeoMethodGuard } from "@/lib/api/geo-handler";
import { exportReport, reportDownloadResponse, reportFormatSchema } from "@/server/geo/reports-core";

export const Route = createFileRoute("/api/v1/geo/reports/$id/export")({
	server: {
		handlers: withGeoMethodGuard({
			GET: createGeoApiHandler({
				permission: "report.read",
				params: z.object({ id: z.guid() }),
				query: z.object({ format: reportFormatSchema }),
				handle: async ({ params, query, principal }) =>
					reportDownloadResponse(await exportReport(principal, params.id, query.format)),
			}),
		}),
	},
});
