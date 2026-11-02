import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { createGeoApiHandler, withGeoMethodGuard } from "@/lib/api/geo-handler";
import { downloadKnowledgeAsset } from "@/server/geo/knowledge-assets-core";

export const Route = createFileRoute("/api/v1/geo/knowledge-assets/$assetId/file")({
	server: {
		handlers: withGeoMethodGuard({
			GET: createGeoApiHandler({
				permission: "knowledge.read",
				params: z.object({ assetId: z.string().uuid() }),
				handle: ({ principal, params }) => downloadKnowledgeAsset(principal, params.assetId),
			}),
		}),
	},
});
