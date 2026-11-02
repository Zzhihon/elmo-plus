import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { createGeoApiHandler, withGeoMethodGuard } from "@/lib/api/geo-handler";
import { getKnowledgeAsset } from "@/server/geo/knowledge-assets-core";

export const Route = createFileRoute("/api/v1/geo/knowledge-assets/$assetId/")({
	server: {
		handlers: withGeoMethodGuard({
			GET: createGeoApiHandler({
				permission: "knowledge.read",
				params: z.object({ assetId: z.string().uuid() }),
				handle: async ({ principal, params }) => ({ data: await getKnowledgeAsset(principal, params.assetId) }),
			}),
		}),
	},
});
