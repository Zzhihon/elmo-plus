import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { createGeoApiHandler, withGeoMethodGuard } from "@/lib/api/geo-handler";
import { freezePromptSet } from "@/server/geo/prompts-core";

export const Route = createFileRoute("/api/v1/geo/prompt-sets/$id/freeze")({
	server: {
		handlers: withGeoMethodGuard({
			POST: createGeoApiHandler({
				permission: "prompt.freeze",
				params: z.object({ id: z.uuid() }),
				idempotent: true,
				handle: async ({ principal, params }) => freezePromptSet(principal, params.id),
			}),
		}),
	},
});
