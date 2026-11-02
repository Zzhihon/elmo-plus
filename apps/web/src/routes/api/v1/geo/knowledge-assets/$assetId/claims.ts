import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { createGeoApiHandler, withGeoMethodGuard } from "@/lib/api/geo-handler";
import { registerAssetClaim, registerClaimSchema } from "@/server/geo/knowledge-assets-core";

export const Route = createFileRoute("/api/v1/geo/knowledge-assets/$assetId/claims")({
	server: {
		handlers: withGeoMethodGuard({
			POST: createGeoApiHandler({
				permission: "knowledge.write",
				params: z.object({ assetId: z.string().uuid() }),
				body: registerClaimSchema,
				idempotent: true,
				handle: async ({ principal, params, body }) => {
					const result = await registerAssetClaim(principal, params.assetId, body);
					return Response.json({ data: result }, { status: result.created ? 201 : 200 });
				},
			}),
		}),
	},
});
