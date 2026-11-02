import { createFileRoute } from "@tanstack/react-router";
import { createGeoApiHandler, withGeoMethodGuard } from "@/lib/api/geo-handler";
import { getInsights, metricQuerySchema } from "@/server/geo/metrics-core";

/** PRD 5.2 metrics for one fixed comparison, per platform and surface mode, never pooled. */
export const Route = createFileRoute("/api/v1/geo/metrics/")({
	server: {
		handlers: withGeoMethodGuard({
			GET: createGeoApiHandler({
				permission: "metric.read",
				query: metricQuerySchema,
				handle: async ({ query, principal }) => ({ data: await getInsights(principal, query) }),
			}),
		}),
	},
});
