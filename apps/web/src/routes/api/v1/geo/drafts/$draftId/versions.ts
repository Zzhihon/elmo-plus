import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { createGeoApiHandler, withGeoMethodGuard } from "@/lib/api/geo-handler";
import { reviseDraft, reviseDraftSchema } from "@/server/geo/drafts-core";

export const Route = createFileRoute("/api/v1/geo/drafts/$draftId/versions")({
	server: {
		handlers: withGeoMethodGuard({
			POST: createGeoApiHandler({
				permission: "content.write",
				params: z.object({ draftId: z.string().uuid() }),
				body: reviseDraftSchema,
				status: 201,
				idempotent: true,
				handle: async ({ principal, params, body }) => ({ data: await reviseDraft(principal, params.draftId, body) }),
			}),
		}),
	},
});
