import { createFileRoute } from "@tanstack/react-router";
import { createGeoApiHandler, withGeoMethodGuard } from "@/lib/api/geo-handler";
import { listSamplingTargets } from "@/server/geo/sampling-targets-core";

export const Route = createFileRoute("/api/v1/geo/targets/")({
	server: {
		handlers: withGeoMethodGuard({
			GET: createGeoApiHandler({
				permission: "target.read",
				handle: async ({ principal }) => ({ data: await listSamplingTargets(principal) }),
			}),
		}),
	},
});
