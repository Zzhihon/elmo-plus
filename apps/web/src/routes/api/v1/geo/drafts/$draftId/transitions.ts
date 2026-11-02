import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { createGeoApiHandler, withGeoMethodGuard } from "@/lib/api/geo-handler";
import { draftTransitionSchema, transitionDraft } from "@/server/geo/drafts-core";

export const Route = createFileRoute("/api/v1/geo/drafts/$draftId/transitions")({
	server: {
		handlers: withGeoMethodGuard({
			POST: createGeoApiHandler({
				permission: "content.write",
				params: z.object({ draftId: z.string().uuid() }),
				body: draftTransitionSchema,
				idempotent: true,
				handle: async ({ principal, params, body }) => ({
					data: await transitionDraft(principal, params.draftId, body),
				}),
			}),
		}),
	},
});
