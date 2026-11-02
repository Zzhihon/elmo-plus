/**
 * POST /api/v1/geo/knowledge-claims/{id}/reviews — confirm, reject, ask for
 * evidence, invalidate, resubmit, freeze or unfreeze. Appends to the review
 * history; the claim's state machine and the high-risk gates decide what this
 * caller may do.
 */
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { createGeoApiHandler, withGeoMethodGuard } from "@/lib/api/geo-handler";
import { claimReviewSchema, reviewClaim } from "@/server/geo/knowledge-core";

export const Route = createFileRoute("/api/v1/geo/knowledge-claims/$claimId/reviews")({
	server: {
		handlers: withGeoMethodGuard({
			POST: createGeoApiHandler({
				permission: "knowledge.write",
				params: z.object({ claimId: z.string().uuid() }),
				body: claimReviewSchema,
				idempotent: true,
				handle: async ({ principal, params, body }) => ({ data: await reviewClaim(principal, params.claimId, body) }),
			}),
		}),
	},
});
