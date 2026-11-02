import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { createGeoApiHandler, withGeoMethodGuard } from "@/lib/api/geo-handler";
import { importPromptsCsv } from "@/server/geo/prompts-core";

export const Route = createFileRoute("/api/v1/geo/prompts/import")({
	server: {
		handlers: withGeoMethodGuard({
			POST: createGeoApiHandler({
				permission: "prompt.write",
				body: z.object({
					csv: z
						.string()
						.min(1)
						.max(2 * 1024 * 1024),
				}),
				idempotent: true,
				handle: async ({ principal, body }) => {
					const result = await importPromptsCsv(principal, body.csv);
					return result.errors.length > 0 ? Response.json(result, { status: 422 }) : result;
				},
			}),
		}),
	},
});
