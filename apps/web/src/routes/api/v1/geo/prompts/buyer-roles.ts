import { createFileRoute } from "@tanstack/react-router";
import { createGeoApiHandler, withGeoMethodGuard } from "@/lib/api/geo-handler";
import { listBuyerRoles } from "@/server/geo/prompts-core";

export const Route = createFileRoute("/api/v1/geo/prompts/buyer-roles")({
	server: {
		handlers: withGeoMethodGuard({
			GET: createGeoApiHandler({
				permission: "prompt.read",
				handle: async ({ principal }) => ({ data: await listBuyerRoles(principal) }),
			}),
		}),
	},
});
