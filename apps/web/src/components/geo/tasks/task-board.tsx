import { Link } from "@tanstack/react-router";
import { GEO_TASK_STATE_LABELS } from "@workspace/geo-domain";
import { Alert, AlertDescription } from "@workspace/ui/components/alert";
import { Skeleton } from "@workspace/ui/components/skeleton";
import { GeoEmptyState } from "@/components/geo/shell/empty-state";
import { GeoStatusBadge } from "@/components/geo/shell/status-badge";
import type { TaskSummary } from "@/server/geo/tasks-core";
import { BOARD_COLUMNS, errorMessage, PRIORITY_LABELS, TASK_KIND_LABELS } from "./labels";
import { useGeoBoardTasks } from "./queries";

function TaskCard({ task, orgSlug }: { task: TaskSummary; orgSlug: string }) {
	return (
		<Link
			to="/app/org/$org/geo/tasks/$id"
			params={{ org: orgSlug, id: task.id }}
			className="block rounded-md border bg-background p-3 text-sm shadow-xs transition-colors hover:bg-muted/50"
		>
			<p className="line-clamp-2 font-medium">{task.title}</p>
			<div className="mt-2 flex flex-wrap items-center gap-1.5">
				<GeoStatusBadge label={PRIORITY_LABELS[task.priority]} tone={task.priority === "P0" ? "danger" : "neutral"} />
				{task.riskLevel === "HIGH" && <GeoStatusBadge label="高风险" tone="warning" />}
				<span className="text-xs text-muted-foreground">{TASK_KIND_LABELS[task.kind]}</span>
			</div>
			<p className="mt-2 text-xs text-muted-foreground">{task.ownerName ?? "未指派"}</p>
		</Link>
	);
}

export function GeoTaskBoard({ organizationId, orgSlug }: { organizationId: string; orgSlug: string }) {
	const { data, isLoading, error } = useGeoBoardTasks(organizationId);

	if (isLoading) return <Skeleton className="h-96 w-full" />;
	if (error)
		return (
			<Alert variant="destructive">
				<AlertDescription>{errorMessage(error)}</AlertDescription>
			</Alert>
		);
	if (!data || data.rows.length === 0) {
		return (
			<GeoEmptyState title="还没有优化工单" description="从采样证据、站点审计发现或知识断言创建工单，或手动新建。" />
		);
	}

	const columns = BOARD_COLUMNS.map((state) => ({
		state,
		tasks: data.rows.filter((task) => task.state === state),
	})).filter((column) => column.tasks.length > 0 || !["REJECTED", "PAUSED", "CANCELLED"].includes(column.state));

	return (
		<div className="flex flex-col gap-3">
			{data.truncated && (
				<Alert>
					<AlertDescription>工单较多，看板只显示最近更新的部分，请在列表中筛选查看全部。</AlertDescription>
				</Alert>
			)}
			<div className="flex gap-3 overflow-x-auto pb-2">
				{columns.map((column) => (
					<div key={column.state} className="flex w-64 shrink-0 flex-col gap-2 rounded-lg bg-muted/40 p-2">
						<div className="flex items-center justify-between px-1 text-sm font-medium">
							<span>{GEO_TASK_STATE_LABELS[column.state]}</span>
							<span className="tabular-nums text-muted-foreground">{column.tasks.length}</span>
						</div>
						{column.tasks.map((task) => (
							<TaskCard key={task.id} task={task} orgSlug={orgSlug} />
						))}
					</div>
				))}
			</div>
			<p className="text-xs text-muted-foreground">已验证、已取消的工单只显示近 30 天更新的。</p>
		</div>
	);
}
