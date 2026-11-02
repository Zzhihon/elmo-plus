import { useQuery } from "@tanstack/react-query";
import { getGeoTaskChoicesFn, getGeoTaskFn, listGeoBoardTasksFn, listGeoTasksFn } from "@/server/geo/tasks";
import type { TaskListQuery } from "@/server/geo/tasks-core";

export const geoTaskKeys = {
	all: (organizationId: string) => ["geo-tasks", organizationId] as const,
	board: (organizationId: string) => ["geo-tasks", organizationId, "board"] as const,
	list: (organizationId: string, filters: TaskListQuery, page: number) =>
		["geo-tasks", organizationId, "list", filters, page] as const,
	detail: (organizationId: string, taskId: string) => ["geo-tasks", organizationId, "detail", taskId] as const,
	choices: (organizationId: string) => ["geo-tasks", organizationId, "choices"] as const,
};

export function useGeoBoardTasks(organizationId: string) {
	return useQuery({
		queryKey: geoTaskKeys.board(organizationId),
		queryFn: () => listGeoBoardTasksFn({ data: { organizationId } }),
	});
}

export function useGeoTaskList(organizationId: string, filters: TaskListQuery, page: number) {
	return useQuery({
		queryKey: geoTaskKeys.list(organizationId, filters, page),
		queryFn: () => listGeoTasksFn({ data: { organizationId, filters, page, limit: 20 } }),
		placeholderData: (previous) => previous,
	});
}

export function useGeoTask(organizationId: string, taskId: string) {
	return useQuery({
		queryKey: geoTaskKeys.detail(organizationId, taskId),
		queryFn: () => getGeoTaskFn({ data: { organizationId, taskId } }),
	});
}

export function useGeoTaskChoices(organizationId: string, enabled = true) {
	return useQuery({
		queryKey: geoTaskKeys.choices(organizationId),
		queryFn: () => getGeoTaskChoicesFn({ data: { organizationId } }),
		staleTime: 60_000,
		enabled,
	});
}
