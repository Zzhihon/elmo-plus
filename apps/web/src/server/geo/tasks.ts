import { createServerFn } from "@tanstack/react-start";
import { getDeployment } from "@workspace/deployment";
import { GeoError } from "@workspace/geo-domain";
import { z } from "zod";
import { READ_ONLY_MESSAGE } from "@/lib/read-only-errors";
import { requireGeoServerFnPrincipal, resolveGeoSessionPrincipal } from "./context";
import {
	createTask,
	createTaskSchema,
	getTaskDetail,
	listAssignees,
	listBoardTasks,
	listPromptChoices,
	listTaskBatches,
	listTasks,
	taskFiltersSchema,
	transitionSchema,
	transitionTask,
	updateTask,
	updateTaskSchema,
} from "./tasks-core";

const orgOnly = z.object({ organizationId: z.string() });

export const listGeoTasksFn = createServerFn({ method: "GET" })
	.validator(
		orgOnly.extend({
			filters: taskFiltersSchema.optional(),
			page: z.number().int().min(1).default(1),
			limit: z.number().int().min(1).max(100).default(20),
		}),
	)
	.handler(async ({ data }) => {
		const principal = await requireGeoServerFnPrincipal(data.organizationId, "task.read");
		const { rows, total } = await listTasks(principal, data.filters ?? {}, {
			limit: data.limit,
			offset: (data.page - 1) * data.limit,
		});
		return { rows, total, page: data.page, totalPages: Math.max(1, Math.ceil(total / data.limit)) };
	});

export const listGeoBoardTasksFn = createServerFn({ method: "GET" })
	.validator(orgOnly)
	.handler(async ({ data }) => {
		const principal = await requireGeoServerFnPrincipal(data.organizationId, "task.read");
		return listBoardTasks(principal);
	});

export const getGeoTaskFn = createServerFn({ method: "GET" })
	.validator(orgOnly.extend({ taskId: z.string().uuid() }))
	.handler(async ({ data }) => {
		const principal = await requireGeoServerFnPrincipal(data.organizationId, "task.read");
		return getTaskDetail(principal, data.taskId);
	});

export const getGeoTaskChoicesFn = createServerFn({ method: "GET" })
	.validator(orgOnly)
	.handler(async ({ data }) => {
		const principal = await requireGeoServerFnPrincipal(data.organizationId, "task.read");
		const [assignees, batches, prompts] = await Promise.all([
			listAssignees(principal),
			listTaskBatches(principal),
			listPromptChoices(principal),
		]);
		return { assignees, batches, prompts };
	});

export const createGeoTaskFn = createServerFn({ method: "POST" })
	.validator(orgOnly.extend({ input: createTaskSchema }))
	.handler(async ({ data }) => {
		const principal = await requireGeoServerFnPrincipal(data.organizationId, "task.create");
		const { task, created } = await createTask(principal, data.input);
		return { id: task.id, title: task.title, created };
	});

/**
 * Reviewers hold no `task.transition`, so this asks only for membership; the
 * state machine decides which action this person may take.
 */
export const transitionGeoTaskFn = createServerFn({ method: "POST" })
	.validator(orgOnly.extend({ taskId: z.string().uuid(), input: transitionSchema }))
	.handler(async ({ data }) => {
		const principal = await resolveGeoSessionPrincipal(data.organizationId);
		if (getDeployment().features.readOnly) throw new GeoError("FORBIDDEN", READ_ONLY_MESSAGE);
		const task = await transitionTask(principal, data.taskId, data.input);
		return { id: task.id, state: task.state };
	});

export const updateGeoTaskFn = createServerFn({ method: "POST" })
	.validator(orgOnly.extend({ taskId: z.string().uuid(), input: updateTaskSchema }))
	.handler(async ({ data }) => {
		const principal = await requireGeoServerFnPrincipal(data.organizationId, "task.transition");
		const task = await updateTask(principal, data.taskId, data.input);
		return { id: task.id, state: task.state };
	});
