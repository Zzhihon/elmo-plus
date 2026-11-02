import { Link } from "@tanstack/react-router";
import {
	GEO_PRIORITIES,
	GEO_TASK_KINDS,
	GEO_TASK_STATE_LABELS,
	GEO_TASK_STATES,
	type GeoPriority,
	type GeoTaskKind,
	type GeoTaskState,
} from "@workspace/geo-domain";
import { Alert, AlertDescription } from "@workspace/ui/components/alert";
import { Input } from "@workspace/ui/components/input";
import { Skeleton } from "@workspace/ui/components/skeleton";
import { useState } from "react";
import { GeoEmptyState } from "@/components/geo/shell/empty-state";
import { GeoPaginatedTable } from "@/components/geo/shell/paginated-table";
import { GeoStatusBadge, GeoTaskStateBadge } from "@/components/geo/shell/status-badge";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import type { TaskSummary } from "@/server/geo/tasks-core";
import { errorMessage, formatDateTime, PRIORITY_LABELS, TASK_KIND_LABELS } from "./labels";
import { useGeoTaskChoices, useGeoTaskList } from "./queries";
import { SimpleSelect } from "./simple-select";

export function GeoTaskList({ organizationId, orgSlug }: { organizationId: string; orgSlug: string }) {
	const [state, setState] = useState<GeoTaskState | null>(null);
	const [priority, setPriority] = useState<GeoPriority | null>(null);
	const [kind, setKind] = useState<GeoTaskKind | null>(null);
	const [ownerId, setOwnerId] = useState<string | null>(null);
	const [search, setSearch] = useState("");
	const [page, setPage] = useState(1);
	const q = useDebouncedValue(search.trim(), 300);
	const choices = useGeoTaskChoices(organizationId);

	const filters = {
		state: state ? [state] : undefined,
		priority: priority ?? undefined,
		kind: kind ?? undefined,
		ownerId: ownerId ?? undefined,
		q: q || undefined,
	};
	const { data, isLoading, error } = useGeoTaskList(organizationId, filters, page);
	const reset =
		<T,>(setter: (value: T) => void) =>
		(value: T) => {
			setter(value);
			setPage(1);
		};

	return (
		<div className="flex flex-col gap-3">
			<div className="grid grid-cols-2 gap-2 md:grid-cols-5">
				<Input placeholder="搜索标题或建议动作" value={search} onChange={(e) => reset(setSearch)(e.target.value)} />
				<SimpleSelect
					value={state}
					onChange={reset(setState)}
					noneLabel="全部状态"
					options={GEO_TASK_STATES.map((value) => ({ value, label: GEO_TASK_STATE_LABELS[value] }))}
				/>
				<SimpleSelect
					value={priority}
					onChange={reset(setPriority)}
					noneLabel="全部优先级"
					options={GEO_PRIORITIES.map((value) => ({ value, label: PRIORITY_LABELS[value] }))}
				/>
				<SimpleSelect
					value={kind}
					onChange={reset(setKind)}
					noneLabel="全部类型"
					options={GEO_TASK_KINDS.map((value) => ({ value, label: TASK_KIND_LABELS[value] }))}
				/>
				<SimpleSelect
					value={ownerId}
					onChange={reset(setOwnerId)}
					noneLabel="全部责任人"
					options={(choices.data?.assignees ?? []).map((person) => ({ value: person.id, label: person.name }))}
				/>
			</div>
			{error && (
				<Alert variant="destructive">
					<AlertDescription>{errorMessage(error)}</AlertDescription>
				</Alert>
			)}
			{isLoading && !data ? (
				<Skeleton className="h-64 w-full" />
			) : (
				<GeoPaginatedTable<TaskSummary>
					rows={data?.rows ?? []}
					total={data?.total ?? 0}
					page={page}
					totalPages={data?.totalPages ?? 1}
					onPageChange={setPage}
					rowKey={(task) => task.id}
					empty={<GeoEmptyState title="没有符合条件的工单" />}
					columns={[
						{
							key: "title",
							header: "标题",
							cell: (task) => (
								<Link
									to="/app/org/$org/geo/tasks/$id"
									params={{ org: orgSlug, id: task.id }}
									className="font-medium hover:underline"
								>
									{task.title}
								</Link>
							),
						},
						{ key: "state", header: "状态", cell: (task) => <GeoTaskStateBadge state={task.state} /> },
						{ key: "kind", header: "类型", cell: (task) => TASK_KIND_LABELS[task.kind] },
						{
							key: "priority",
							header: "优先级",
							cell: (task) => (
								<div className="flex gap-1">
									<GeoStatusBadge
										label={PRIORITY_LABELS[task.priority]}
										tone={task.priority === "P0" ? "danger" : "neutral"}
									/>
									{task.riskLevel === "HIGH" && <GeoStatusBadge label="高风险" tone="warning" />}
								</div>
							),
						},
						{ key: "owner", header: "责任人", cell: (task) => task.ownerName ?? "未指派" },
						{
							key: "prompt",
							header: "目标问法",
							cell: (task) => <span className="line-clamp-1 max-w-64">{task.promptQuestion ?? "—"}</span>,
						},
						{ key: "updated", header: "更新时间", cell: (task) => formatDateTime(task.updatedAt) },
					]}
				/>
			)}
		</div>
	);
}
