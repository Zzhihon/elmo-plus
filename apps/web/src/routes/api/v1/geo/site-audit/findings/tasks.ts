import { createFileRoute } from "@tanstack/react-router";
import { createGeoApiHandler, withGeoMethodGuard } from "@/lib/api/geo-handler";
import { createTasksFromFindings, findingTasksSchema } from "@/server/geo/site-audit-core";

export const Route = createFileRoute("/api/v1/geo/site-audit/findings/tasks")({
	server: {
		handlers: withGeoMethodGuard({
			POST: createGeoApiHandler({
				permission: "task.create",
				body: findingTasksSchema,
				idempotent: true,
				handle: async ({ principal, body }) => {
					const result = await createTasksFromFindings(principal, body);
					const created = result.tasks.some((task) => task.created);
					return Response.json({ data: result }, { status: created ? 201 : 200 });
				},
			}),
		}),
	},
});
