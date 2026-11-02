import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { createGeoApiHandler, geoPaging, withGeoMethodGuard } from "@/lib/api/geo-handler";
import { batchRunsQuerySchema, getSamplingBatch } from "@/server/geo/sampling-core";

export const Route = createFileRoute("/api/v1/geo/sampling-runs/$id")({
	server: {
		handlers: withGeoMethodGuard({
			GET: createGeoApiHandler({
				permission: "sampling.read",
				params: z.object({ id: z.guid("采样批次 ID 无效") }),
				query: batchRunsQuerySchema,
				handle: async ({ params, query, request, principal }) => {
					const paging = geoPaging(request);
					const detail = await getSamplingBatch(principal, params.id, paging, query);
					return {
						data: detail,
						pagination: {
							page: paging.page,
							limit: paging.limit,
							total: detail.runTotal,
							totalPages: Math.ceil(detail.runTotal / paging.limit),
						},
					};
				},
			}),
		}),
	},
});
