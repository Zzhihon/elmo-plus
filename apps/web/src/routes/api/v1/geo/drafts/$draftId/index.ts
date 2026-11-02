import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { createGeoApiHandler, withGeoMethodGuard } from "@/lib/api/geo-handler";
import { getDraftDetail } from "@/server/geo/drafts-core";

export const Route = createFileRoute("/api/v1/geo/drafts/$draftId/")({
	server: {
		handlers: withGeoMethodGuard({
			GET: createGeoApiHandler({
				permission: "content.read",
				params: z.object({ draftId: z.string().uuid() }),
				handle: async ({ principal, params }) => ({ data: await getDraftDetail(principal, params.draftId) }),
			}),
		}),
	},
});
