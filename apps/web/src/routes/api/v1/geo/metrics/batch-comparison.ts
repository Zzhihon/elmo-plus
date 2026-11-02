import { createFileRoute } from "@tanstack/react-router";
import { createGeoApiHandler, withGeoMethodGuard } from "@/lib/api/geo-handler";
import { batchComparisonQuerySchema, compareBatchesFor } from "@/server/geo/metrics-core";

export const Route = createFileRoute("/api/v1/geo/metrics/batch-comparison")({
	server: {
		handlers: withGeoMethodGuard({
			GET: createGeoApiHandler({
				permission: "metric.read",
				query: batchComparisonQuerySchema,
				handle: async ({ query, principal }) => ({ data: await compareBatchesFor(principal, query) }),
			}),
		}),
	},
});
