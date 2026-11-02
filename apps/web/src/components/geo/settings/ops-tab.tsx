import { useQueryClient } from "@tanstack/react-query";
import { GEO_PLATFORM_LABELS, GEO_TASK_STATE_LABELS, type GeoPlatform, type GeoTaskState } from "@workspace/geo-domain";
import { Button } from "@workspace/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@workspace/ui/components/card";
import { Skeleton } from "@workspace/ui/components/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@workspace/ui/components/table";
import type { ReactNode } from "react";
import { useState } from "react";
import { type GeoBadgeTone, GeoStatusBadge } from "@/components/geo/shell/status-badge";
import { useGeoViewer } from "@/components/geo/shell/use-geo-viewer";
import { errorMessage, formatDateTime } from "@/components/geo/tasks/labels";
import { setGeoAlertStatusFn } from "@/server/geo/admin";
import type { GeoOpsMetrics } from "@/server/geo/admin-core";
import { ResultNotice } from "./notice";
import { geoAdminKeys, useGeoAlerts, useGeoOpsMetrics } from "./queries";

const NO_DATA = "无数据";

function percent(part: number, whole: number): string {
	return whole === 0 ? NO_DATA : `${Math.round((part / whole) * 100)}%`;
}

function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
	return (
		<div className="rounded-lg border p-3">
			<div className="text-xs text-muted-foreground">{label}</div>
			<div className="mt-1 text-xl font-semibold tabular-nums">{value}</div>
			{hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
		</div>
	);
}

function SamplingStats({ metrics }: { metrics: GeoOpsMetrics }) {
	const { sampling, retries, review, reports } = metrics;
	const settled = sampling.planned - sampling.inFlight;
	return (
		<div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
			<Stat label="计划采样" value={sampling.planned || NO_DATA} hint={`近 ${metrics.windowDays} 天`} />
			<Stat
				label="有效"
				value={sampling.planned ? sampling.valid : NO_DATA}
				hint={`有效率 ${percent(sampling.valid, settled)}`}
			/>
			<Stat label="失败" value={sampling.planned ? sampling.failed : NO_DATA} hint="含超时、限流" />
			<Stat label="不可用" value={sampling.planned ? sampling.unavailable : NO_DATA} hint="含待人工、验证码" />
			<Stat label="重试 / 重采" value={`${retries.retriedAttempts} / ${retries.resampledRuns}`} />
			<Stat
				label="评估复核比例"
				value={percent(review.reviewed, review.total)}
				hint={review.total ? `待复核 ${review.pending}` : undefined}
			/>
			<Stat
				label="报告生成成功率"
				value={percent(reports.succeeded, reports.succeeded + reports.failed)}
				hint={`近 ${reports.windowDays} 天，进行中 ${reports.pending}`}
			/>
		</div>
	);
}

function DurationTable({ metrics }: { metrics: GeoOpsMetrics }) {
	if (metrics.durations.length === 0) return <p className="text-sm text-muted-foreground">{NO_DATA}</p>;
	return (
		<Table>
			<TableHeader>
				<TableRow>
					<TableHead>平台</TableHead>
					<TableHead>尝试次数</TableHead>
					<TableHead>P50 用时</TableHead>
					<TableHead>P95 用时</TableHead>
					<TableHead>单次平均成本</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				{metrics.durations.map((row) => (
					<TableRow key={row.platform}>
						<TableCell>{GEO_PLATFORM_LABELS[row.platform as GeoPlatform] ?? row.platform}</TableCell>
						<TableCell className="tabular-nums">{row.samples}</TableCell>
						<TableCell className="tabular-nums">
							{row.p50 === null ? NO_DATA : `${(row.p50 / 1000).toFixed(1)} 秒`}
						</TableCell>
						<TableCell className="tabular-nums">
							{row.p95 === null ? NO_DATA : `${(row.p95 / 1000).toFixed(1)} 秒`}
						</TableCell>
						<TableCell className="tabular-nums">{row.avgCost === null ? NO_DATA : row.avgCost.toFixed(4)}</TableCell>
					</TableRow>
				))}
			</TableBody>
		</Table>
	);
}

function QueueTable({ metrics }: { metrics: GeoOpsMetrics }) {
	if (metrics.queues === null) return <p className="text-sm text-muted-foreground">无法读取队列状态。</p>;
	if (metrics.queues.length === 0) return <p className="text-sm text-muted-foreground">worker 尚未创建 GEO 队列。</p>;
	return (
		<Table>
			<TableHeader>
				<TableRow>
					<TableHead>队列</TableHead>
					<TableHead>排队</TableHead>
					<TableHead>延后</TableHead>
					<TableHead>执行中</TableHead>
					<TableHead>近期失败</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				{metrics.queues.map((queue) => (
					<TableRow key={queue.name}>
						<TableCell className="font-mono text-xs">{queue.name}</TableCell>
						<TableCell className="tabular-nums">{queue.queued}</TableCell>
						<TableCell className="tabular-nums">{queue.deferred}</TableCell>
						<TableCell className="tabular-nums">{queue.active}</TableCell>
						<TableCell className="tabular-nums">{queue.failed}</TableCell>
					</TableRow>
				))}
			</TableBody>
		</Table>
	);
}

const BACKUP_KIND_LABELS: Record<string, string> = {
	DAILY: "每日备份",
	PRE_MIGRATION: "迁移前备份",
	RESTORE_DRILL: "恢复演练",
};

const HEALTH: Record<string, { label: string; tone: GeoBadgeTone }> = {
	ok: { label: "正常", tone: "success" },
	stale: { label: "超过 26 小时未成功备份", tone: "danger" },
	failed: { label: "最近一次备份失败", tone: "danger" },
};

function BackupStatus({ metrics }: { metrics: GeoOpsMetrics }) {
	const health = HEALTH[metrics.backups.health.state];
	return (
		<div className="space-y-3">
			<div className="flex flex-wrap items-center gap-2 text-sm">
				<GeoStatusBadge label={health.label} tone={health.tone} />
				<span className="text-muted-foreground">上次成功：{formatDateTime(metrics.backups.health.lastSuccessAt)}</span>
			</div>
			{metrics.backups.latest.length === 0 ? (
				<p className="text-sm text-muted-foreground">尚无备份记录。备份脚本运行后会在此登记。</p>
			) : (
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>类型</TableHead>
							<TableHead>结果</TableHead>
							<TableHead>完成时间</TableHead>
							<TableHead>耗时</TableHead>
							<TableHead>异地副本</TableHead>
							<TableHead>说明</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{metrics.backups.latest.map((run) => (
							<TableRow key={run.kind}>
								<TableCell>{BACKUP_KIND_LABELS[run.kind] ?? run.kind}</TableCell>
								<TableCell>
									<GeoStatusBadge
										label={run.status === "SUCCEEDED" ? "成功" : "失败"}
										tone={run.status === "SUCCEEDED" ? "success" : "danger"}
									/>
								</TableCell>
								<TableCell>{formatDateTime(run.finishedAt)}</TableCell>
								<TableCell className="tabular-nums">
									{run.durationSeconds === null ? "—" : `${Math.round(run.durationSeconds / 60)} 分钟`}
								</TableCell>
								<TableCell>{run.offsiteCopied ? "是" : "否"}</TableCell>
								<TableCell className="max-w-64 truncate">{run.message ?? run.location ?? "—"}</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			)}
		</div>
	);
}

function OverdueApprovals({ metrics }: { metrics: GeoOpsMetrics }) {
	const { overdueTasks, overdueRequests } = metrics.approvals;
	if (overdueTasks.length + overdueRequests.length === 0)
		return <p className="text-sm text-muted-foreground">没有超时的审批。</p>;
	return (
		<ul className="space-y-1 text-sm">
			{overdueTasks.map((task) => (
				<li key={task.id}>
					工单「{task.title}」{GEO_TASK_STATE_LABELS[task.state as GeoTaskState]}，自 {formatDateTime(task.enteredAt)}{" "}
					起
				</li>
			))}
			{overdueRequests.length > 0 && <li>{overdueRequests.length} 个管理审批申请超过 48 小时未处理</li>}
		</ul>
	);
}

const SEVERITY_TONES: Record<string, GeoBadgeTone> = { CRITICAL: "danger", WARNING: "warning", INFO: "info" };
const ALERT_LABELS: Record<string, string> = {
	"approval-timeout": "审批超时",
	"backup-failed": "备份失败",
	"backup-stale": "备份过期",
};

function AlertList({ organizationId }: { organizationId: string }) {
	const viewer = useGeoViewer();
	const queryClient = useQueryClient();
	const [showResolved, setShowResolved] = useState(false);
	const { data } = useGeoAlerts(organizationId, showResolved);
	const [error, setError] = useState<string | null>(null);

	async function update(alertId: string, status: "ACK" | "RESOLVED") {
		setError(null);
		try {
			await setGeoAlertStatusFn({ data: { organizationId, input: { alertId, status } } });
			await queryClient.invalidateQueries({ queryKey: geoAdminKeys.all(organizationId) });
		} catch (err) {
			setError(errorMessage(err));
		}
	}

	return (
		<div className="space-y-3">
			<div className="flex justify-end">
				<Button size="sm" variant="outline" onClick={() => setShowResolved(!showResolved)}>
					{showResolved ? "只看未关闭" : "包含已关闭"}
				</Button>
			</div>
			<ResultNotice error={error} />
			{(data ?? []).length === 0 ? (
				<p className="text-sm text-muted-foreground">没有告警。</p>
			) : (
				<ul className="divide-y text-sm">
					{(data ?? []).map((alert) => (
						<li key={alert.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
							<div className="flex flex-wrap items-center gap-2">
								<GeoStatusBadge label={alert.severity} tone={SEVERITY_TONES[alert.severity] ?? "neutral"} />
								<span>{ALERT_LABELS[alert.kind] ?? alert.kind}</span>
								<span className="text-xs text-muted-foreground">
									{formatDateTime(alert.firstSeen)} 起，{alert.occurrences} 次 · {alert.status}
								</span>
							</div>
							{alert.status !== "RESOLVED" && viewer.can("alert.manage") && (
								<div className="flex gap-2">
									{alert.status === "OPEN" && (
										<Button size="sm" variant="outline" onClick={() => update(alert.id, "ACK")}>
											确认
										</Button>
									)}
									<Button size="sm" variant="outline" onClick={() => update(alert.id, "RESOLVED")}>
										关闭
									</Button>
								</div>
							)}
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
	return (
		<Card>
			<CardHeader>
				<CardTitle className="text-base">{title}</CardTitle>
			</CardHeader>
			<CardContent>{children}</CardContent>
		</Card>
	);
}

export function GeoOpsTab({ organizationId }: { organizationId: string }) {
	const { data, isLoading } = useGeoOpsMetrics(organizationId);
	if (isLoading || !data) return <Skeleton className="h-96 w-full" />;
	return (
		<div className="flex flex-col gap-4">
			<SamplingStats metrics={data} />
			<div className="grid gap-4 lg:grid-cols-2">
				<Panel title="各平台采样用时">
					<DurationTable metrics={data} />
				</Panel>
				<Panel title="队列积压（全实例）">
					<QueueTable metrics={data} />
				</Panel>
				<Panel title="数据库备份（全实例）">
					<BackupStatus metrics={data} />
				</Panel>
				<Panel title="审批超时">
					<OverdueApprovals metrics={data} />
				</Panel>
			</div>
			<Panel title="告警">
				<AlertList organizationId={organizationId} />
			</Panel>
		</div>
	);
}
