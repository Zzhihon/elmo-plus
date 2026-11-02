import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { createGeoApiHandler, withGeoMethodGuard } from "@/lib/api/geo-handler";
import { getPromptSet, promptSetItemsSchema, updatePromptSetItems } from "@/server/geo/prompts-core";

const params = z.object({ id: z.uuid() });

export const Route = createFileRoute("/api/v1/geo/prompt-sets/$id/")({
	server: {
		handlers: withGeoMethodGuard({
			GET: createGeoApiHandler({
				permission: "prompt.read",
				params,
				handle: async ({ principal, params }) => getPromptSet(principal, params.id),
			}),
			PATCH: createGeoApiHandler({
				permission: "prompt.write",
				params,
				body: promptSetItemsSchema,
				idempotent: true,
				handle: async ({ principal, params, body }) => updatePromptSetItems(principal, params.id, body),
			}),
		}),
	},
});
