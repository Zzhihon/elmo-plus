import { createFileRoute } from "@tanstack/react-router";
import { createGeoApiHandler, geoPage, geoPaging, withGeoMethodGuard } from "@/lib/api/geo-handler";
import { createBatchInputSchema, createSamplingBatch, listSamplingBatches } from "@/server/geo/sampling-core";

/** A sampling run here is a batch: frozen questions × targets × repeats, executed asynchronously. */
export const Route = createFileRoute("/api/v1/geo/sampling-runs/")({
	server: {
		handlers: withGeoMethodGuard({
			GET: createGeoApiHandler({
				permission: "sampling.read",
				handle: async ({ request, principal }) => {
					const paging = geoPaging(request);
					const { rows, total } = await listSamplingBatches(principal, paging);
					return geoPage(rows, total, paging);
				},
			}),
			POST: createGeoApiHandler({
				permission: "sampling.run",
				body: createBatchInputSchema,
				status: 202,
				idempotent: true,
				handle: async ({ body, request, principal }) => {
					const result = await createSamplingBatch(principal, body, request.headers.get("Idempotency-Key"));
					return {
						data: { ...result.batch, estimatedCost: result.estimatedCost },
						created: result.created,
						job_id: result.jobId,
					};
				},
			}),
		}),
	},
});
