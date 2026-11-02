import { Input } from "@workspace/ui/components/input";
import { Label } from "@workspace/ui/components/label";
import { Skeleton } from "@workspace/ui/components/skeleton";
import { useState } from "react";
import { GeoEmptyState } from "@/components/geo/shell/empty-state";
import { GeoPaginatedTable } from "@/components/geo/shell/paginated-table";
import { formatDateTime } from "@/components/geo/tasks/labels";
import { SimpleSelect } from "@/components/geo/tasks/simple-select";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import type { AuditQuery } from "@/server/geo/admin-core";
import { useGeoAuditLogs, useGeoMembers } from "./queries";

const ACTOR_KIND_LABELS: Record<string, string> = {
	user: "用户",
	api_key: "API Key",
	instance_admin_key: "实例管理密钥",
	system: "系统",
};

function dayStart(value: string): string | undefined {
	return value ? new Date(`${value}T00:00:00`).toISOString() : undefined;
}

function dayEnd(value: string): string | undefined {
	return value ? new Date(`${value}T23:59:59.999`).toISOString() : undefined;
}

type Row = NonNullable<ReturnType<typeof useGeoAuditLogs>["data"]>["rows"][number];

export function GeoAuditTab({ organizationId, initialEntityId }: { organizationId: string; initialEntityId?: string }) {
	const members = useGeoMembers(organizationId);
	const [actorId, setActorId] = useState<string | null>(null);
	const [action, setAction] = useState("");
	const [entityType, setEntityType] = useState("");
	const [entityId, setEntityId] = useState(initialEntityId ?? "");
	const [from, setFrom] = useState("");
	const [to, setTo] = useState("");
	const [page, setPage] = useState(1);
	const debounced = useDebouncedValue({ action, entityType, entityId }, 300);

	const filters: AuditQuery = {
		actorId: actorId ?? undefined,
		action: debounced.action.trim() || undefined,
		entityType: debounced.entityType.trim() || undefined,
		entityId: debounced.entityId.trim() || undefined,
		from: dayStart(from),
		to: dayEnd(to),
	};
	const { data, isLoading } = useGeoAuditLogs(organizationId, filters, page);
	const resetting =
		<T,>(setter: (value: T) => void) =>
		(value: T) => {
			setter(value);
			setPage(1);
		};

	return (
		<div className="flex flex-col gap-3">
			<div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
				<div className="space-y-1">
					<Label htmlFor="audit-actor">操作人</Label>
					<SimpleSelect
						id="audit-actor"
						value={actorId}
						onChange={resetting(setActorId)}
						noneLabel="全部"
						options={(members.data ?? []).map((member) => ({ value: member.userId, label: member.name }))}
					/>
				</div>
				<div className="space-y-1">
					<Label htmlFor="audit-action">动作</Label>
					<Input
						id="audit-action"
						value={action}
						onChange={(e) => resetting(setAction)(e.target.value)}
						placeholder="如 task. 或 secret.rotate"
					/>
				</div>
				<div className="space-y-1">
					<Label htmlFor="audit-entity-type">实体类型</Label>
					<Input
						id="audit-entity-type"
						value={entityType}
						onChange={(e) => resetting(setEntityType)(e.target.value)}
						placeholder="如 geo_optimization_task"
					/>
				</div>
				<div className="space-y-1">
					<Label htmlFor="audit-entity">实体 ID</Label>
					<Input id="audit-entity" value={entityId} onChange={(e) => resetting(setEntityId)(e.target.value)} />
				</div>
				<div className="space-y-1">
					<Label htmlFor="audit-from">开始日期</Label>
					<Input id="audit-from" type="date" value={from} onChange={(e) => resetting(setFrom)(e.target.value)} />
				</div>
				<div className="space-y-1">
					<Label htmlFor="audit-to">结束日期</Label>
					<Input id="audit-to" type="date" value={to} onChange={(e) => resetting(setTo)(e.target.value)} />
				</div>
			</div>
			<p className="text-xs text-muted-foreground">
				审计日志只保存变更前后的哈希值，不保存内容本身；密钥类字段一律脱敏。
			</p>
			{isLoading && !data ? (
				<Skeleton className="h-64 w-full" />
			) : (
				<GeoPaginatedTable<Row>
					rows={data?.rows ?? []}
					total={data?.total ?? 0}
					page={page}
					totalPages={data?.totalPages ?? 1}
					onPageChange={setPage}
					rowKey={(row) => row.id}
					empty={<GeoEmptyState title="没有符合条件的审计记录" />}
					columns={[
						{ key: "time", header: "时间", cell: (row) => formatDateTime(row.createdAt) },
						{
							key: "actor",
							header: "操作人",
							cell: (row) => (
								<div>
									<div>{row.actorName ?? row.actorId}</div>
									<div className="text-xs text-muted-foreground">
										{ACTOR_KIND_LABELS[row.actorKind] ?? row.actorKind}
									</div>
								</div>
							),
						},
						{ key: "action", header: "动作", cell: (row) => <span className="font-mono text-xs">{row.action}</span> },
						{
							key: "entity",
							header: "实体",
							cell: (row) => (
								<div className="font-mono text-xs">
									<div>{row.entityType}</div>
									<div className="break-all text-muted-foreground">{row.entityId}</div>
								</div>
							),
						},
						{
							key: "metadata",
							header: "详情",
							cell: (row) => (
								<span className="line-clamp-2 max-w-80 break-all font-mono text-xs">
									{row.metadata ? JSON.stringify(row.metadata) : "—"}
								</span>
							),
						},
						{
							key: "request",
							header: "请求 ID",
							cell: (row) => <span className="font-mono text-xs text-muted-foreground">{row.requestId ?? "—"}</span>,
						},
					]}
				/>
			)}
		</div>
	);
}
