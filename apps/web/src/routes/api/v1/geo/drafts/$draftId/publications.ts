import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { createGeoApiHandler, withGeoMethodGuard } from "@/lib/api/geo-handler";
import { publicationSchema, recordPublication } from "@/server/geo/drafts-core";

export const Route = createFileRoute("/api/v1/geo/drafts/$draftId/publications")({
	server: {
		handlers: withGeoMethodGuard({
			POST: createGeoApiHandler({
				permission: "content.publish",
				params: z.object({ draftId: z.string().uuid() }),
				body: publicationSchema,
				status: 201,
				idempotent: true,
				handle: async ({ principal, params, body }) => ({
					data: await recordPublication(principal, params.draftId, body),
				}),
			}),
		}),
	},
});
