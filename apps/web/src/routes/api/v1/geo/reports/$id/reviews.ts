import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { createGeoApiHandler, withGeoMethodGuard } from "@/lib/api/geo-handler";
import { reportReviewInputSchema, reviewReport } from "@/server/geo/reports-core";

export const Route = createFileRoute("/api/v1/geo/reports/$id/reviews")({
	server: {
		handlers: withGeoMethodGuard({
			POST: createGeoApiHandler({
				permission: "report.review",
				params: z.object({ id: z.guid() }),
				body: reportReviewInputSchema,
				idempotent: true,
				handle: async ({ params, body, principal }) => ({ data: await reviewReport(principal, params.id, body) }),
			}),
		}),
	},
});
