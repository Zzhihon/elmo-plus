import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { createGeoApiHandler, withGeoMethodGuard } from "@/lib/api/geo-handler";
import { conflictResolutionSchema, resolveConflict } from "@/server/geo/knowledge-core";

export const Route = createFileRoute("/api/v1/geo/knowledge-claims/conflicts/$conflictId/resolution")({
	server: {
		handlers: withGeoMethodGuard({
			POST: createGeoApiHandler({
				permission: "knowledge.review",
				params: z.object({ conflictId: z.string().uuid() }),
				body: conflictResolutionSchema,
				idempotent: true,
				handle: async ({ principal, params, body }) => ({
					data: await resolveConflict(principal, params.conflictId, body),
				}),
			}),
		}),
	},
});
