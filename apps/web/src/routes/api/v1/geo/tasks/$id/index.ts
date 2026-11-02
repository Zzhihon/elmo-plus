/** /api/v1/geo/tasks/:id — one task with its events, evidence, linked content and retest comparison. */
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { createGeoApiHandler, withGeoMethodGuard } from "@/lib/api/geo-handler";
import { getTaskDetail } from "@/server/geo/tasks-core";

export const Route = createFileRoute("/api/v1/geo/tasks/$id/")({
	server: {
		handlers: withGeoMethodGuard({
			GET: createGeoApiHandler({
				permission: "task.read",
				params: z.object({ id: z.string().uuid() }),
				handle: async ({ principal, params }) => ({ data: await getTaskDetail(principal, params.id) }),
			}),
		}),
	},
});
