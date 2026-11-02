/**
 * /api/v1/geo/tasks — optimization tasks.
 *
 * GET   list and filter (state as a comma-separated list, ownerId, priority, kind, promptId, q)
 * POST  create; a second create for a source with an open task returns that task with 200
 */
import { createFileRoute } from "@tanstack/react-router";
import { createGeoApiHandler, geoPage, geoPaging, withGeoMethodGuard } from "@/lib/api/geo-handler";
import { createTask, createTaskSchema, listTasks, taskListQuerySchema } from "@/server/geo/tasks-core";

export const Route = createFileRoute("/api/v1/geo/tasks/")({
	server: {
		handlers: withGeoMethodGuard({
			GET: createGeoApiHandler({
				permission: "task.read",
				query: taskListQuerySchema,
				handle: async ({ request, principal, query }) => {
					const paging = geoPaging(request);
					const { rows, total } = await listTasks(principal, query, paging);
					return geoPage(rows, total, paging);
				},
			}),
			POST: createGeoApiHandler({
				permission: "task.create",
				body: createTaskSchema,
				idempotent: true,
				handle: async ({ principal, body }) => {
					const { task, created } = await createTask(principal, body);
					return Response.json({ data: task, created }, { status: created ? 201 : 200 });
				},
			}),
		}),
	},
});
