import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { createGeoApiHandler, withGeoMethodGuard } from "@/lib/api/geo-handler";
import { attachAssetSource, attachSourceSchema } from "@/server/geo/knowledge-assets-core";

export const Route = createFileRoute("/api/v1/geo/knowledge-claims/$claimId/sources")({
	server: {
		handlers: withGeoMethodGuard({
			POST: createGeoApiHandler({
				permission: "knowledge.write",
				params: z.object({ claimId: z.string().uuid() }),
				body: attachSourceSchema,
				status: 201,
				idempotent: true,
				handle: async ({ principal, params, body }) => ({
					data: await attachAssetSource(principal, params.claimId, body),
				}),
			}),
		}),
	},
});
