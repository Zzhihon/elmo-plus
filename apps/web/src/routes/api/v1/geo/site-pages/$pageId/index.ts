import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { createGeoApiHandler, withGeoMethodGuard } from "@/lib/api/geo-handler";
import { getSitePage } from "@/server/geo/site-core";

export const Route = createFileRoute("/api/v1/geo/site-pages/$pageId/")({
	server: {
		handlers: withGeoMethodGuard({
			GET: createGeoApiHandler({
				permission: "site.read",
				params: z.object({ pageId: z.string().uuid() }),
				handle: async ({ principal, params }) => ({ data: await getSitePage(principal, params.pageId) }),
			}),
		}),
	},
});
