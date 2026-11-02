import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { createGeoApiHandler, withGeoMethodGuard } from "@/lib/api/geo-handler";
import {
	getObservationReview,
	observationReviewInputSchema,
	submitObservationReview,
} from "@/server/geo/evaluation-core";

/** Reviews append evaluation versions or settle fact claims; the observation itself is never written. */
export const Route = createFileRoute("/api/v1/geo/observations/$id/reviews")({
	server: {
		handlers: withGeoMethodGuard({
			GET: createGeoApiHandler({
				permission: "observation.read",
				params: z.object({ id: z.guid() }),
				handle: async ({ params, principal }) => ({ data: await getObservationReview(principal, params.id) }),
			}),
			POST: createGeoApiHandler({
				permission: "observation.review",
				params: z.object({ id: z.guid() }),
				body: observationReviewInputSchema,
				status: 201,
				idempotent: true,
				handle: async ({ params, body, principal }) => ({
					data: await submitObservationReview(principal, params.id, body),
				}),
			}),
		}),
	},
});
