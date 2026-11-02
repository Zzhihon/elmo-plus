import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { createGeoApiHandler, withGeoMethodGuard } from "@/lib/api/geo-handler";
import { reparseSchema, requestReparse } from "@/server/geo/site-core";

export const Route = createFileRoute("/api/v1/geo/site-pages/$pageId/reparse")({
	server: {
		handlers: withGeoMethodGuard({
			POST: createGeoApiHandler({
				permission: "site.reparse",
				params: z.object({ pageId: z.string().uuid() }),
				body: reparseSchema,
				status: 202,
				idempotent: true,
				handle: async ({ principal, params, body }) => ({ data: await requestReparse(principal, params.pageId, body) }),
			}),
		}),
	},
});
