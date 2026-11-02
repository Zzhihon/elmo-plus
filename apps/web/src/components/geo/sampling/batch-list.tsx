import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { GEO_RUN_STATUS_LABELS, GEO_RUN_STATUSES, type GeoRunStatus } from "@workspace/geo-domain";
import { Alert, AlertDescription } from "@workspace/ui/components/alert";
import { Button, buttonVariants } from "@workspace/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@workspace/ui/components/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@workspace/ui/components/select";
import { Skeleton } from "@workspace/ui/components/skeleton";
import { useState } from "react";
import { GeoPlatformBadge, GeoSurfaceModeBadge } from "@/components/geo/shell/evidence-badge";
import { GeoPaginatedTable, type GeoTableColumn } from "@/components/geo/shell/paginated-table";
import { GeoBatchStatusBadge, GeoRunStatusBadge } from "@/components/geo/shell/status-badge";
import { useGeoViewer } from "@/components/geo/shell/use-geo-viewer";
import { useWriteErrorMessage } from "@/lib/write-errors";
import { getSamplingBatchFn, listSamplingBatchesFn, setSamplingBatchPausedFn } from "@/server/geo/sampling";
import type { BatchListItem, BatchRunView } from "@/server/geo/sampling-core";
import { formatCost, formatDateTime, formatRate } from "./format";
import { samplingKeys } from "./keys";
import { ResampleDialog } from "./resample-dialog";
import { useGeoOrganization } from "./use-geo-organization";

const ACTIVE = new Set(["PLANNED", "RUNNING"]);
const TERMINAL = new Set<GeoRunStatus>(
	GEO_RUN_STATUSES.filter((status) => status !== "PLANNED" && status !== "RUNNING"),
);
const ALL_STATUSES = "ALL";

function Counts({ batch }: { batch: BatchListItem }) {
	const settled = batch.validCount + batch.partialCount + batch.unavailableCount + batch.failedCount;
	return (
		<div className="text-xs tabular-nums text-muted-foreground">
			<div>
				有效 {batch.validCount} / 计划 {batch.plannedCount}（{formatRate(batch.validCount, batch.plannedCount)}）
			</div>
			<div>
				部分 {batch.partialCount} · 不可用 {batch.unavailableCount} · 失败 {batch.failedCount} · 待完成{" "}
				{Math.max(0, batch.plannedCount - settled)}
			</div>
		</div>
	);
}

function BatchRuns({ batchId }: { batchId: string }) {
	const organization = useGeoOrganization();
	const viewer = useGeoViewer();
	const [page, setPage] = useState(1);
	const [status, setStatus] = useState<string>(ALL_STATUSES);
	const [resampling, setResampling] = useState<string | null>(null);
	const filter = status === ALL_STATUSES ? undefined : (status as GeoRunStatus);
	const detail = useQuery({
		queryKey: samplingKeys.batch(organization.id, batchId, page, filter),
		queryFn: () =>
			getSamplingBatchFn({ data: { organizationId: organization.id, batchId, page, limit: 20, status: filter } }),
		placeholderData: keepPreviousData,
		refetchInterval: (query) => (query.state.data && ACTIVE.has(query.state.data.status) ? 10_000 : false),
	});
	if (!detail.data) return <Skeleton className="h-48 w-full" />;
	const data = detail.data;

	const columns: GeoTableColumn<BatchRunView>[] = [
		{
			key: "question",
			header: "问题",
			cell: (run) => <span className="line-clamp-2 max-w-72">{run.questionText}</span>,
		},
		{
			key: "target",
			header: "目标",
			cell: (run) => (
				<div className="flex flex-wrap gap-1">
					<GeoPlatformBadge platform={run.platform} />
					<GeoSurfaceModeBadge mode={run.surfaceMode} />
				</div>
			),
		},
		{
			key: "repeat",
			header: "轮次",
			cell: (run) => `第 ${run.repeatIndex + 1} 次${run.retryRelation ? "（重采）" : ""}`,
		},
		{
			key: "status",
			header: "状态",
			cell: (run) => (
				<div className="flex flex-col gap-1">
					<GeoRunStatusBadge status={run.status} />
					{run.errorCode && <span className="text-xs text-muted-foreground">{run.errorCode}</span>}
				</div>
			),
		},
		{ key: "attempts", header: "尝试", cell: (run) => run.attemptCount, className: "tabular-nums" },
		{
			key: "actions",
			header: "",
			className: "text-right",
			cell: (run) => (
				<div className="flex justify-end gap-2">
					{run.observationId && (
						<Link
							to="/app/org/$org/geo/observations/$id"
							params={{ org: organization.slug, id: run.observationId }}
							className={buttonVariants({ variant: "outline", size: "sm" })}
						>
							证据
						</Link>
					)}
					{viewer.can("sampling.run") && TERMINAL.has(run.status) && (
						<Button variant="ghost" size="sm" onClick={() => setResampling(run.id)}>
							重采
						</Button>
					)}
				</div>
			),
		},
	];

	return (
		<div className="flex flex-col gap-4">
			<div className="grid gap-2 sm:grid-cols-2">
				{data.targets.map((target) => (
					<div key={target.targetId} className="rounded-md border p-3 text-xs">
						<div className="mb-1 flex flex-wrap items-center gap-1">
							<GeoPlatformBadge platform={target.platform} />
							<GeoSurfaceModeBadge mode={target.surfaceMode} />
						</div>
						<p className="text-muted-foreground">
							{Object.entries(target.statuses)
								.map(([key, value]) => `${GEO_RUN_STATUS_LABELS[key as GeoRunStatus]} ${value}`)
								.join(" · ")}
						</p>
					</div>
				))}
			</div>
			<Select
				items={{ [ALL_STATUSES]: "全部状态", ...GEO_RUN_STATUS_LABELS }}
				value={status}
				onValueChange={(value) => {
					setStatus(value as string);
					setPage(1);
				}}
			>
				<SelectTrigger className="w-40" aria-label="按状态筛选">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value={ALL_STATUSES}>全部状态</SelectItem>
					{GEO_RUN_STATUSES.map((item) => (
						<SelectItem key={item} value={item}>
							{GEO_RUN_STATUS_LABELS[item]}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			<GeoPaginatedTable
				columns={columns}
				rows={data.runs}
				rowKey={(run) => run.id}
				page={data.page}
				totalPages={data.totalPages}
				total={data.runTotal}
				onPageChange={setPage}
			/>
			{resampling && <ResampleDialog runId={resampling} onClose={() => setResampling(null)} />}
		</div>
	);
}

function PauseButton({ batch, onError }: { batch: BatchListItem; onError: (message: string) => void }) {
	const organization = useGeoOrganization();
	const queryClient = useQueryClient();
	const writeError = useWriteErrorMessage();
	const paused = batch.status === "PAUSED";
	const toggle = useMutation({
		mutationFn: () =>
			setSamplingBatchPausedFn({ data: { organizationId: organization.id, batchId: batch.id, paused: !paused } }),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: samplingKeys.all(organization.id) }),
		onError: (err) => onError(writeError(err, "操作失败")),
	});
	if (!paused && !ACTIVE.has(batch.status)) return null;
	return (
		<Button variant="outline" size="sm" disabled={toggle.isPending} onClick={() => toggle.mutate()}>
			{paused ? "恢复" : "暂停"}
		</Button>
	);
}

export function BatchList() {
	const organization = useGeoOrganization();
	const viewer = useGeoViewer();
	const [page, setPage] = useState(1);
	const [open, setOpen] = useState<BatchListItem | null>(null);
	const [error, setError] = useState<string | null>(null);
	const batches = useQuery({
		queryKey: samplingKeys.batches(organization.id, page),
		queryFn: () => listSamplingBatchesFn({ data: { organizationId: organization.id, page, limit: 20 } }),
		placeholderData: keepPreviousData,
		refetchInterval: (query) => (query.state.data?.rows.some((row) => ACTIVE.has(row.status)) ? 10_000 : false),
	});

	const columns: GeoTableColumn<BatchListItem>[] = [
		{ key: "created", header: "发起时间", cell: (batch) => formatDateTime(batch.createdAt) },
		{
			key: "set",
			header: "问法集",
			cell: (batch) => `${batch.promptSet.name} · v${batch.promptSet.version}`,
		},
		{ key: "plan", header: "计划", cell: (batch) => `${batch.targetCount} 个目标 × ${batch.repeatCount} 次` },
		{ key: "status", header: "状态", cell: (batch) => <GeoBatchStatusBadge status={batch.status} /> },
		{ key: "counts", header: "结果", cell: (batch) => <Counts batch={batch} /> },
		{ key: "cost", header: "费用估算", cell: (batch) => formatCost(batch.costEstimate), className: "tabular-nums" },
		{
			key: "actions",
			header: "",
			className: "text-right",
			cell: (batch) => (
				<div className="flex justify-end gap-2">
					{viewer.can("sampling.run") && <PauseButton batch={batch} onError={setError} />}
					<Button variant="ghost" size="sm" onClick={() => setOpen(batch)}>
						详情
					</Button>
				</div>
			),
		},
	];

	if (!batches.data) return <Skeleton className="h-40 w-full" />;
	return (
		<div className="flex flex-col gap-3">
			{error && (
				<Alert variant="destructive">
					<AlertDescription>{error}</AlertDescription>
				</Alert>
			)}
			<GeoPaginatedTable
				columns={columns}
				rows={batches.data.rows}
				rowKey={(batch) => batch.id}
				page={batches.data.page}
				totalPages={batches.data.totalPages}
				total={batches.data.total}
				onPageChange={setPage}
			/>
			<Dialog open={open !== null} onOpenChange={(next) => !next && setOpen(null)}>
				<DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-5xl">
					<DialogHeader>
						<DialogTitle>采样批次详情</DialogTitle>
						<DialogDescription>
							{open &&
								`${open.promptSet.name} · v${open.promptSet.version}，发起于 ${formatDateTime(open.createdAt)}。`}
							重试不会重复计数；失败、限流和不可用的样本不计入任何比率。
						</DialogDescription>
					</DialogHeader>
					{open && <BatchRuns batchId={open.id} />}
				</DialogContent>
			</Dialog>
		</div>
	);
}
