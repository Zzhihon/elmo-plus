import { createFileRoute } from "@tanstack/react-router";
import { createGeoApiHandler, geoPage, geoPaging, withGeoMethodGuard } from "@/lib/api/geo-handler";
import { createReport, createReportInputSchema, listReports } from "@/server/geo/reports-core";

export const Route = createFileRoute("/api/v1/geo/reports/")({
	server: {
		handlers: withGeoMethodGuard({
			GET: createGeoApiHandler({
				permission: "report.read",
				handle: async ({ request, principal }) => {
					const paging = geoPaging(request);
					const { rows, total } = await listReports(principal, paging);
					return geoPage(rows, total, paging);
				},
			}),
			POST: createGeoApiHandler({
				permission: "report.generate",
				body: createReportInputSchema,
				status: 202,
				idempotent: true,
				handle: async ({ body, principal }) => {
					const { report, jobId } = await createReport(principal, body);
					return { data: report, job_id: jobId };
				},
			}),
		}),
	},
});
