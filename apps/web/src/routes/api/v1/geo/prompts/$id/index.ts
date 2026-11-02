import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { createGeoApiHandler, withGeoMethodGuard } from "@/lib/api/geo-handler";
import { getPrompt, promptPatchSchema, updatePrompt } from "@/server/geo/prompts-core";

const params = z.object({ id: z.uuid() });

export const Route = createFileRoute("/api/v1/geo/prompts/$id/")({
	server: {
		handlers: withGeoMethodGuard({
			GET: createGeoApiHandler({
				permission: "prompt.read",
				params,
				handle: async ({ principal, params }) => getPrompt(principal, params.id),
			}),
			PATCH: createGeoApiHandler({
				permission: "prompt.write",
				params,
				body: promptPatchSchema.refine((patch) => Object.keys(patch).length > 0, "至少需要修改一个字段"),
				idempotent: true,
				handle: async ({ principal, params, body }) => updatePrompt(principal, params.id, body),
			}),
		}),
	},
});
