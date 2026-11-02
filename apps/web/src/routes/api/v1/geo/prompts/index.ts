import { createFileRoute } from "@tanstack/react-router";
import { createGeoApiHandler, geoPage, geoPaging, withGeoMethodGuard } from "@/lib/api/geo-handler";
import { createPrompt, listPrompts, promptInputSchema, promptListQuerySchema } from "@/server/geo/prompts-core";

export const Route = createFileRoute("/api/v1/geo/prompts/")({
	server: {
		handlers: withGeoMethodGuard({
			GET: createGeoApiHandler({
				permission: "prompt.read",
				query: promptListQuerySchema,
				handle: async ({ principal, request, query }) => {
					const paging = geoPaging(request);
					const { rows, total } = await listPrompts(principal, query, paging);
					return geoPage(rows, total, paging);
				},
			}),
			POST: createGeoApiHandler({
				permission: "prompt.write",
				body: promptInputSchema,
				status: 201,
				idempotent: true,
				handle: async ({ principal, body }) => createPrompt(principal, body),
			}),
		}),
	},
});
