import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { createGeoApiHandler, withGeoMethodGuard } from "@/lib/api/geo-handler";
import { assetReviewSchema, reviewKnowledgeAsset } from "@/server/geo/knowledge-assets-core";

export const Route = createFileRoute("/api/v1/geo/knowledge-assets/$assetId/reviews")({
	server: {
		handlers: withGeoMethodGuard({
			POST: createGeoApiHandler({
				permission: "knowledge.review",
				params: z.object({ assetId: z.string().uuid() }),
				body: assetReviewSchema,
				idempotent: true,
				handle: async ({ principal, params, body }) => {
					const asset = await reviewKnowledgeAsset(principal, params.assetId, body);
					return { data: { id: asset.id, approvalStatus: asset.approvalStatus } };
				},
			}),
		}),
	},
});
