import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { createGeoApiHandler, withGeoMethodGuard } from "@/lib/api/geo-handler";
import { createNextPromptSetVersion } from "@/server/geo/prompts-core";

export const Route = createFileRoute("/api/v1/geo/prompt-sets/$id/versions")({
	server: {
		handlers: withGeoMethodGuard({
			POST: createGeoApiHandler({
				permission: "prompt.write",
				params: z.object({ id: z.uuid() }),
				status: 201,
				idempotent: true,
				handle: async ({ principal, params }) => createNextPromptSetVersion(principal, params.id),
			}),
		}),
	},
});
