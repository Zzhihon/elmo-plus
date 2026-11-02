/**
 * /api/v1/geo/tasks/:id/transitions — move a task through its workflow.
 *
 * The state machine checks the action against the caller's roles; keys carry no
 * reviewer role, so review and approval happen in the workspace by a named person.
 */
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { createGeoApiHandler, withGeoMethodGuard } from "@/lib/api/geo-handler";
import { transitionSchema, transitionTask } from "@/server/geo/tasks-core";

export const Route = createFileRoute("/api/v1/geo/tasks/$id/transitions")({
	server: {
		handlers: withGeoMethodGuard({
			POST: createGeoApiHandler({
				permission: "task.transition",
				params: z.object({ id: z.string().uuid() }),
				body: transitionSchema,
				idempotent: true,
				handle: async ({ principal, params, body }) => ({ data: await transitionTask(principal, params.id, body) }),
			}),
		}),
	},
});
