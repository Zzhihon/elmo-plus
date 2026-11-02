import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { createGeoApiHandler, withGeoMethodGuard } from "@/lib/api/geo-handler";
import { promptTransitionSchema, transitionPrompt } from "@/server/geo/prompts-core";

export const Route = createFileRoute("/api/v1/geo/prompts/$id/transitions")({
	server: {
		handlers: withGeoMethodGuard({
			// Approving or rejecting also needs `prompt.review`, which no key carries; the core checks it per action.
			POST: createGeoApiHandler({
				permission: "prompt.write",
				params: z.object({ id: z.uuid() }),
				body: promptTransitionSchema,
				idempotent: true,
				handle: async ({ principal, params, body }) => transitionPrompt(principal, params.id, body),
			}),
		}),
	},
});
