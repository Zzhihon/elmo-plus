import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { createGeoApiHandler, withGeoMethodGuard } from "@/lib/api/geo-handler";
import { getObservation } from "@/server/geo/observations-core";

export const Route = createFileRoute("/api/v1/geo/observations/$id")({
	server: {
		handlers: withGeoMethodGuard({
			GET: createGeoApiHandler({
				permission: "observation.read",
				params: z.object({ id: z.guid("证据 ID 无效") }),
				handle: async ({ params, principal }) => ({ data: await getObservation(principal, params.id) }),
			}),
		}),
	},
});
