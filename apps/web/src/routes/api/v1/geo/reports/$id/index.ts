import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { createGeoApiHandler, withGeoMethodGuard } from "@/lib/api/geo-handler";
import { getReport } from "@/server/geo/reports-core";

export const Route = createFileRoute("/api/v1/geo/reports/$id/")({
	server: {
		handlers: withGeoMethodGuard({
			GET: createGeoApiHandler({
				permission: "report.read",
				params: z.object({ id: z.guid() }),
				handle: async ({ params, principal }) => ({ data: await getReport(principal, params.id) }),
			}),
		}),
	},
});
