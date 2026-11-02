import { createFileRoute } from "@tanstack/react-router";
import { createGeoApiHandler, withGeoMethodGuard } from "@/lib/api/geo-handler";
import { createPromptSet, listPromptSets, promptSetInputSchema } from "@/server/geo/prompts-core";

export const Route = createFileRoute("/api/v1/geo/prompt-sets/")({
	server: {
		handlers: withGeoMethodGuard({
			GET: createGeoApiHandler({
				permission: "prompt.read",
				handle: async ({ principal }) => ({ data: await listPromptSets(principal) }),
			}),
			POST: createGeoApiHandler({
				permission: "prompt.write",
				body: promptSetInputSchema,
				status: 201,
				idempotent: true,
				handle: async ({ principal, body }) => createPromptSet(principal, body),
			}),
		}),
	},
});
