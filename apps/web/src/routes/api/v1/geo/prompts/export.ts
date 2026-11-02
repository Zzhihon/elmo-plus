import { createFileRoute } from "@tanstack/react-router";
import { createGeoApiHandler, withGeoMethodGuard } from "@/lib/api/geo-handler";
import { exportPromptsCsv, promptListQuerySchema } from "@/server/geo/prompts-core";

export const Route = createFileRoute("/api/v1/geo/prompts/export")({
	server: {
		handlers: withGeoMethodGuard({
			GET: createGeoApiHandler({
				permission: "prompt.read",
				query: promptListQuerySchema,
				handle: async ({ principal, query }) =>
					new Response(await exportPromptsCsv(principal, query), {
						headers: {
							"Content-Type": "text/csv; charset=utf-8",
							"Content-Disposition": 'attachment; filename="geo-prompts.csv"',
						},
					}),
			}),
		}),
	},
});
