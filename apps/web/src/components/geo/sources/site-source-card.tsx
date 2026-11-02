import { IconAlertTriangle } from "@tabler/icons-react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, AlertDescription, AlertTitle } from "@workspace/ui/components/alert";
import { Button } from "@workspace/ui/components/button";
import { Card, CardContent, CardHeader } from "@workspace/ui/components/card";
import { Skeleton } from "@workspace/ui/components/skeleton";
import { useState } from "react";
import { GeoPaginatedTable } from "@/components/geo/shell/paginated-table";
import { GeoStatusBadge } from "@/components/geo/shell/status-badge";
import { useGeoViewer } from "@/components/geo/shell/use-geo-viewer";
import {
	CrawlStatusBadge,
	errorMessage,
	formatDateTime,
	formatNumber,
	formatPercent,
	siteQueryKeys,
} from "@/components/geo/site-pages/site-labels";
import {
	getSiteFn,
	listCrawlRunsFn,
	retryFailedUrlsFn,
	setCrawlRunPausedFn,
	startCrawlFn,
	updateSiteFn,
} from "@/server/geo/site";
import type { CrawlRunView, SiteSourceView } from "@/server/geo/site-core";
import { CrawlRunDialog } from "./crawl-run-dialog";
import { SiteSourceDialog } from "./site-source-dialog";

const ALERT_LABELS: Record<string, string> = {
	"site.sync_failed": "同步失败",
	"site.sync_stale": "超过 48 小时未成功同步",
	"site.section_drop": "重点栏目页面数骤降",
	"site.parse_rate": "解析成功率低于阈值",
	"site.review_backlog": "待审核事实超过约定时限",
	"site.blocked_responses": "源站大量返回 403/429",
	"site.circuit_open": "源站连续失败，已熔断",
	"site.address_blocked": "授权域名解析到非公网地址",
	"site.key_url_coverage": "重点网址未全部覆盖",
};

const TRIGGER_LABELS: Record<string, string> = { MANUAL: "手动", SCHEDULE: "定时", RETRY: "重试失败网址" };

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
	return (
		<div className="rounded-md border p-3">
			<div className="text-xs text-muted-foreground">{label}</div>
			<div className="mt-1 text-lg font-semibold tabular-nums">{value}</div>
			{hint && <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div>}
		</div>
	);
}

type SiteDetail = Awaited<ReturnType<typeof getSiteFn>>;
type SiteMetrics = SiteDetail["metrics"];

function approvedEntitiesHint(metrics: SiteMetrics, source: SiteSourceView): string {
	const parts = Object.entries(metrics.approvedEntitiesBySection).map(
		([key, value]) => `${source.categories.find((category) => category.key === key)?.label ?? key} ${value}`,
	);
	return parts.join("，") || "暂无";
}

function SiteMetricsGrid({ metrics, source }: { metrics: SiteMetrics; source: SiteSourceView }) {
	const host = metrics.hosts[0];
	const breakerOpen = host?.breakerOpenUntil && new Date(host.breakerOpenUntil).getTime() > Date.now();
	const lastRun = metrics.lastRun;
	const approvedTotal = Object.values(metrics.approvedEntitiesBySection).reduce((sum, value) => sum + value, 0);
	return (
		<div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
			<Metric label="已发现网址" value={formatNumber(metrics.discoveredUrls)} />
			<Metric label="范围内抓取成功率" value={formatPercent(lastRun?.successRate)} hint="最近一次任务" />
			<Metric label="内容未变化率" value={formatPercent(lastRun?.unchangedRate)} hint="最近一次任务" />
			<Metric
				label="解析失败率"
				value={formatPercent(metrics.parse.failureRate)}
				hint={`近 30 天 ${metrics.parse.failed}/${metrics.parse.versions}`}
			/>
			<Metric label="疑似失效页面" value={formatNumber(metrics.suspectedDeadPages)} hint="已失效或连续抓取异常" />
			<Metric
				label="重点网址覆盖率"
				value={formatPercent(metrics.keyUrls.ratio)}
				hint={`${metrics.keyUrls.covered}/${metrics.keyUrls.total}`}
			/>
			<Metric
				label="请求速率"
				value={`${lastRun?.observedRequestsPerSecond?.toFixed(2) ?? "—"} 次/秒`}
				hint={`上限 ${metrics.configuredRequestsPerSecond} 次/秒`}
			/>
			<Metric label="响应 P95" value={lastRun?.p95Ms ? `${lastRun.p95Ms} ms` : "—"} />
			<Metric
				label="连续失败次数"
				value={formatNumber(host?.consecutiveFailures ?? 0)}
				hint={breakerOpen ? `熔断至 ${formatDateTime(host?.breakerOpenUntil)}` : "未熔断"}
			/>
			<Metric label="最后成功同步" value={formatDateTime(metrics.lastSuccessAt)} />
			<Metric
				label="已审核实体（按栏目）"
				value={formatNumber(approvedTotal)}
				hint={approvedEntitiesHint(metrics, source)}
			/>
			<Metric
				label="页面状态"
				value={formatNumber(metrics.pagesByStatus.ACTIVE ?? 0)}
				hint={`正常；失效 ${metrics.pagesByStatus.GONE ?? 0}，阻断 ${metrics.pagesByStatus.BLOCKED ?? 0}`}
			/>
		</div>
	);
}

function SiteAlerts({ alerts }: { alerts: SiteDetail["alerts"] }) {
	return (
		<>
			{alerts.map((alert) => (
				<Alert key={alert.id}>
					<IconAlertTriangle />
					<AlertTitle>
						{alert.severity === "CRITICAL" ? "严重：" : "警告："}
						{ALERT_LABELS[alert.kind] ?? alert.kind}
					</AlertTitle>
					<AlertDescription>
						首次 {formatDateTime(alert.firstSeen)}，最近 {formatDateTime(alert.lastSeen)}，共 {alert.occurrences} 次
					</AlertDescription>
				</Alert>
			))}
		</>
	);
}

function SourceSummary({ source }: { source: SiteSourceView }) {
	return (
		<div className="flex min-w-0 flex-col gap-1">
			<div className="flex flex-wrap items-center gap-2">
				<span className="truncate text-lg font-semibold">{source.baseUrl}</span>
				<GeoStatusBadge label={source.enabled ? "采集中" : "已暂停"} tone={source.enabled ? "success" : "warning"} />
				{source.baseUrl.startsWith("http://") && <GeoStatusBadge label="源站仅 HTTP，传输未加密" tone="warning" />}
			</div>
			<div className="text-sm text-muted-foreground">
				授权域名 {source.allowedHosts.join("、")} · 解析配置 {source.profile.id} v{source.profileVersion} · 每秒{" "}
				{source.requestsPerSecond} 次、并发 {source.concurrency} · 页面预算 {formatNumber(source.maxPages)} · 定时{" "}
				{source.crawlCron ?? "0 3 * * *（默认，每 24 小时）"}
				{source.opWindow ? ` · 运营时窗 ${source.opWindow.start}–${source.opWindow.end}` : ""}
			</div>
			{source.authorizationNote && (
				<div className="text-sm text-muted-foreground">授权：{source.authorizationNote}</div>
			)}
		</div>
	);
}

function SourceActions({
	source,
	canCrawl,
	canManage,
	starting,
	toggling,
	onStart,
	onToggle,
	onEdit,
}: {
	source: SiteSourceView;
	canCrawl: boolean;
	canManage: boolean;
	starting: boolean;
	toggling: boolean;
	onStart: (mode: "FULL" | "INCREMENTAL") => void;
	onToggle: () => void;
	onEdit: () => void;
}) {
	const startDisabled = !source.enabled || starting;
	return (
		<div className="flex flex-wrap gap-2">
			{canCrawl && (
				<>
					<Button size="sm" disabled={startDisabled} onClick={() => onStart("INCREMENTAL")}>
						增量采集
					</Button>
					<Button size="sm" variant="outline" disabled={startDisabled} onClick={() => onStart("FULL")}>
						全量采集
					</Button>
				</>
			)}
			{canManage && (
				<>
					<Button size="sm" variant="outline" disabled={toggling} onClick={onToggle}>
						{source.enabled ? "暂停站点" : "恢复站点"}
					</Button>
					<Button size="sm" variant="outline" onClick={onEdit}>
						编辑配置
					</Button>
				</>
			)}
		</div>
	);
}

function RunActions({
	run,
	canCrawl,
	retrying,
	onOpen,
	onPause,
	onRetry,
}: {
	run: CrawlRunView;
	canCrawl: boolean;
	retrying: boolean;
	onOpen: () => void;
	onPause: (paused: boolean) => void;
	onRetry: () => void;
}) {
	const active = run.status === "RUNNING" || run.status === "QUEUED";
	return (
		<div className="flex justify-end gap-1">
			<Button size="sm" variant="ghost" onClick={onOpen}>
				详情
			</Button>
			{canCrawl && active && (
				<Button size="sm" variant="ghost" onClick={() => onPause(true)}>
					暂停
				</Button>
			)}
			{canCrawl && run.status === "PAUSED" && (
				<Button size="sm" variant="ghost" onClick={() => onPause(false)}>
					恢复
				</Button>
			)}
			{canCrawl && (run.summary?.failed ?? 0) > 0 && (
				<Button size="sm" variant="ghost" disabled={retrying} onClick={onRetry}>
					重试失败网址
				</Button>
			)}
		</div>
	);
}

function runCounts(run: CrawlRunView): string {
	if (!run.summary) return "进行中";
	const { succeeded, unchanged, newVersions, failed } = run.summary;
	return `${succeeded} / ${unchanged} / ${newVersions} / ${failed}`;
}

export function SiteSourceCard({
	organizationId,
	orgSlug,
	source,
}: {
	organizationId: string;
	orgSlug: string;
	source: SiteSourceView;
}) {
	const viewer = useGeoViewer();
	const queryClient = useQueryClient();
	const [page, setPage] = useState(1);
	const [openRun, setOpenRun] = useState<string | null>(null);
	const [editing, setEditing] = useState(false);
	const [actionError, setActionError] = useState<string | null>(null);

	const detail = useQuery({
		queryKey: siteQueryKeys.site(organizationId, source.id),
		queryFn: () => getSiteFn({ data: { organizationId, siteId: source.id } }),
		refetchInterval: 30_000,
	});
	const runs = useQuery({
		queryKey: siteQueryKeys.runs(organizationId, source.id, page),
		queryFn: () => listCrawlRunsFn({ data: { organizationId, siteId: source.id, page, limit: 10 } }),
		placeholderData: keepPreviousData,
		refetchInterval: (query) =>
			query.state.data?.rows.some((run) => run.status === "QUEUED" || run.status === "RUNNING") ? 5_000 : 30_000,
	});

	const refresh = () => queryClient.invalidateQueries({ queryKey: siteQueryKeys.all });
	const mutationOptions = { onSuccess: refresh, onError: (error: unknown) => setActionError(errorMessage(error)) };
	const start = useMutation({
		mutationFn: (mode: "FULL" | "INCREMENTAL") =>
			startCrawlFn({ data: { organizationId, siteId: source.id, input: { mode } } }),
		...mutationOptions,
	});
	const pause = useMutation({
		mutationFn: (input: { runId: string; paused: boolean }) =>
			setCrawlRunPausedFn({ data: { organizationId, siteId: source.id, ...input } }),
		...mutationOptions,
	});
	const retry = useMutation({
		mutationFn: (runId: string) => retryFailedUrlsFn({ data: { organizationId, siteId: source.id, runId } }),
		...mutationOptions,
	});
	const toggle = useMutation({
		mutationFn: () =>
			updateSiteFn({ data: { organizationId, siteId: source.id, patch: { enabled: !source.enabled } } }),
		...mutationOptions,
	});

	const metrics = detail.data?.metrics;
	const canCrawl = viewer.can("site.crawl");
	const total = runs.data?.total ?? 0;

	return (
		<Card>
			<CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
				<SourceSummary source={source} />
				<SourceActions
					source={source}
					canCrawl={canCrawl}
					canManage={viewer.can("site.manage")}
					starting={start.isPending}
					toggling={toggle.isPending}
					onStart={(mode) => start.mutate(mode)}
					onToggle={() => toggle.mutate()}
					onEdit={() => setEditing(true)}
				/>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				{actionError && (
					<Alert variant="destructive">
						<AlertDescription>{actionError}</AlertDescription>
					</Alert>
				)}
				<SiteAlerts alerts={detail.data?.alerts ?? []} />
				{detail.isLoading || !metrics ? (
					<Skeleton className="h-28 w-full" />
				) : (
					<SiteMetricsGrid metrics={metrics} source={source} />
				)}
				<div className="flex flex-col gap-2">
					<h3 className="text-sm font-medium">采集任务</h3>
					<GeoPaginatedTable<CrawlRunView>
						rows={runs.data?.rows ?? []}
						total={total}
						page={page}
						totalPages={Math.ceil(total / 10)}
						onPageChange={setPage}
						rowKey={(run) => run.id}
						empty={
							<p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
								还没有采集任务
							</p>
						}
						columns={[
							{ key: "status", header: "状态", cell: (run) => <CrawlStatusBadge status={run.status} /> },
							{
								key: "mode",
								header: "类型",
								cell: (run) =>
									`${run.mode === "FULL" ? "全量" : "增量"} · ${TRIGGER_LABELS[run.config.trigger] ?? run.config.trigger}`,
							},
							{ key: "counts", header: "成功 / 未变化 / 新版本 / 失败", className: "tabular-nums", cell: runCounts },
							{ key: "created", header: "创建", cell: (run) => formatDateTime(run.createdAt) },
							{ key: "finished", header: "结束", cell: (run) => formatDateTime(run.finishedAt) },
							{
								key: "actions",
								header: "",
								className: "text-right",
								cell: (run) => (
									<RunActions
										run={run}
										canCrawl={canCrawl}
										retrying={retry.isPending}
										onOpen={() => setOpenRun(run.id)}
										onPause={(paused) => pause.mutate({ runId: run.id, paused })}
										onRetry={() => retry.mutate(run.id)}
									/>
								),
							},
						]}
					/>
				</div>
			</CardContent>
			<CrawlRunDialog
				organizationId={organizationId}
				orgSlug={orgSlug}
				siteId={source.id}
				runId={openRun}
				onOpenChange={(open) => !open && setOpenRun(null)}
			/>
			{editing && (
				<SiteSourceDialog organizationId={organizationId} source={source} open={editing} onOpenChange={setEditing} />
			)}
		</Card>
	);
}
