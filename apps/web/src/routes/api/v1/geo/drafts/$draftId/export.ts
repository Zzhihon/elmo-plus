import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { createGeoApiHandler, withGeoMethodGuard } from "@/lib/api/geo-handler";
import { exportDraft, exportFormatSchema } from "@/server/geo/drafts-core";

export const Route = createFileRoute("/api/v1/geo/drafts/$draftId/export")({
	server: {
		handlers: withGeoMethodGuard({
			GET: createGeoApiHandler({
				permission: "content.publish",
				params: z.object({ draftId: z.string().uuid() }),
				query: exportFormatSchema,
				handle: ({ principal, params, query }) => exportDraft(principal, params.draftId, query.format),
			}),
		}),
	},
});
