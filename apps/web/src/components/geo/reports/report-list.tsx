import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
	GEO_REPORT_REVIEW_LABELS,
	GEO_REPORT_STATUS_LABELS,
	type GeoReportReviewStatus,
	type GeoReportStatus,
} from "@workspace/geo-domain";
import { Alert, AlertDescription } from "@workspace/ui/components/alert";
import { Button } from "@workspace/ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@workspace/ui/components/dialog";
import { Input } from "@workspace/ui/components/input";
import { Label } from "@workspace/ui/components/label";
import { Skeleton } from "@workspace/ui/components/skeleton";
import { Textarea } from "@workspace/ui/components/textarea";
import { useState } from "react";
import { insightKeys } from "@/components/geo/insights/search";
import { formatDateTime } from "@/components/geo/sampling/format";
import { useGeoOrganization } from "@/components/geo/sampling/use-geo-organization";
import { GeoEmptyState } from "@/components/geo/shell/empty-state";
import { GeoPaginatedTable, type GeoTableColumn } from "@/components/geo/shell/paginated-table";
import { type GeoBadgeTone, GeoStatusBadge } from "@/components/geo/shell/status-badge";
import { errorMessage } from "@/components/geo/tasks/labels";
import { SimpleSelect } from "@/components/geo/tasks/simple-select";
import { listSampledPromptSetsFn } from "@/server/geo/metrics";
import { createReportFn, listReportsFn } from "@/server/geo/reports";
import type { ReportSummary } from "@/server/geo/reports-core";

export const reportKeys = {
	all: (organizationId: string) => ["geo", "reports", organizationId] as const,
	list: (organizationId: string, page: number) => [...reportKeys.all(organizationId), "list", page] as const,
	detail: (organizationId: string, reportId: string) =>
		[...reportKeys.all(organizationId), "detail", reportId] as const,
};

const STATUS_TONE: Record<GeoReportStatus, GeoBadgeTone> = {
	QUEUED: "neutral",
	RUNNING: "info",
	SUCCEEDED: "success",
	FAILED: "danger",
};
const REVIEW_TONE: Record<GeoReportReviewStatus, GeoBadgeTone> = {
	PENDING: "warning",
	APPROVED: "success",
	REJECTED: "danger",
};

export function GeoReportStatusBadges({ report }: { report: Pick<ReportSummary, "status" | "reviewStatus"> }) {
	return (
		<div className="flex flex-wrap gap-1">
			<GeoStatusBadge label={GEO_REPORT_STATUS_LABELS[report.status]} tone={STATUS_TONE[report.status]} />
			{report.status === "SUCCEEDED" && (
				<GeoStatusBadge label={GEO_REPORT_REVIEW_LABELS[report.reviewStatus]} tone={REVIEW_TONE[report.reviewStatus]} />
			)}
		</div>
	);
}

function previousMonth(): string {
	const local = new Date(Date.now() + 8 * 3_600_000);
	local.setUTCDate(1);
	local.setUTCMonth(local.getUTCMonth() - 1);
	return local.toISOString().slice(0, 7);
}

const NARRATIVE_HINT = "报告只描述投入与可见度变化；不要写“订单增长”等未经归因的业务结果，系统会拒绝此类表述。";

export function CreateReportDialog({ onClose }: { onClose: () => void }) {
	const organization = useGeoOrganization();
	const queryClient = useQueryClient();
	const [period, setPeriod] = useState<"month" | "range">("month");
	const [month, setMonth] = useState(previousMonth());
	const [from, setFrom] = useState("");
	const [to, setTo] = useState("");
	const [promptSetId, setPromptSetId] = useState<string | null>(null);
	const [notes, setNotes] = useState("");
	const [nextPlan, setNextPlan] = useState("");
	const sets = useQuery({
		queryKey: [...insightKeys.all(organization.id), "prompt-sets"],
		queryFn: () => listSampledPromptSetsFn({ data: { organizationId: organization.id } }),
	});
	const create = useMutation({
		mutationFn: () =>
			createReportFn({
				data: {
					organizationId: organization.id,
					input: {
						...(period === "month" ? { month } : { from, to }),
						promptSetId,
						notes: notes.trim() || undefined,
						nextPlan: nextPlan
							.split("\n")
							.map((line) => line.trim())
							.filter(Boolean),
					},
				},
			}),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: reportKeys.all(organization.id) });
			onClose();
		},
	});
	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>生成报告</DialogTitle>
					<DialogDescription>
						报告在后台生成，保存当时的指标快照与所用评估版本；之后的复核不会改变已生成的报告。
					</DialogDescription>
				</DialogHeader>
				<div className="flex flex-col gap-4">
					<div className="flex flex-col gap-1.5">
						<Label>周期</Label>
						<SimpleSelect<"month" | "range">
							value={period}
							onChange={(value) => value && setPeriod(value)}
							options={[
								{ value: "month", label: "自然月（北京时间）" },
								{ value: "range", label: "指定日期范围（最长 92 天）" },
							]}
						/>
					</div>
					{period === "month" ? (
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="report-month">月份</Label>
							<Input id="report-month" type="month" value={month} onChange={(event) => setMonth(event.target.value)} />
						</div>
					) : (
						<div className="grid grid-cols-2 gap-3">
							<div className="flex flex-col gap-1.5">
								<Label htmlFor="report-from">开始日期</Label>
								<Input id="report-from" type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
							</div>
							<div className="flex flex-col gap-1.5">
								<Label htmlFor="report-to">结束日期</Label>
								<Input id="report-to" type="date" value={to} onChange={(event) => setTo(event.target.value)} />
							</div>
						</div>
					)}
					<div className="flex flex-col gap-1.5">
						<Label>问法集版本</Label>
						<SimpleSelect
							value={promptSetId}
							onChange={setPromptSetId}
							noneLabel="全部问法集（不建议：会混合版本）"
							options={(sets.data ?? []).map((set) => ({
								value: set.id,
								label: `${set.name} v${set.version}`,
							}))}
						/>
					</div>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="report-notes">补充说明（可选）</Label>
						<Textarea id="report-notes" rows={3} value={notes} onChange={(event) => setNotes(event.target.value)} />
					</div>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="report-plan">下期计划（可选，每行一条；留空则按未完成工单与复核池生成）</Label>
						<Textarea
							id="report-plan"
							rows={3}
							value={nextPlan}
							onChange={(event) => setNextPlan(event.target.value)}
						/>
					</div>
					<p className="text-xs text-muted-foreground">{NARRATIVE_HINT}</p>
					{create.error && (
						<Alert variant="destructive">
							<AlertDescription>{errorMessage(create.error)}</AlertDescription>
						</Alert>
					)}
				</div>
				<DialogFooter>
					<Button variant="outline" onClick={onClose}>
						取消
					</Button>
					<Button
						onClick={() => create.mutate()}
						disabled={create.isPending || (period === "month" ? !month : !from || !to)}
					>
						生成
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

export function GeoReportList({ page, onPageChange }: { page: number; onPageChange: (page: number) => void }) {
	const organization = useGeoOrganization();
	const reports = useQuery({
		queryKey: reportKeys.list(organization.id, page),
		queryFn: () => listReportsFn({ data: { organizationId: organization.id, page } }),
		placeholderData: keepPreviousData,
		refetchInterval: (query) =>
			query.state.data?.rows.some((row) => row.status === "QUEUED" || row.status === "RUNNING") ? 5000 : false,
	});
	const columns: GeoTableColumn<ReportSummary>[] = [
		{
			key: "title",
			header: "报告",
			cell: (row) => (
				<Link
					to="/app/org/$org/geo/reports/$id"
					params={{ org: organization.slug, id: row.id }}
					className="font-medium hover:underline"
				>
					{row.title}
				</Link>
			),
		},
		{ key: "period", header: "周期", cell: (row) => row.periodLabel },
		{ key: "kind", header: "类型", cell: (row) => (row.kind === "MONTHLY" ? "月报" : "专项") },
		{ key: "status", header: "状态", cell: (row) => <GeoReportStatusBadges report={row} /> },
		{ key: "version", header: "口径", cell: (row) => <span className="text-xs">{row.metricVersion}</span> },
		{
			key: "createdAt",
			header: "创建时间",
			cell: (row) => <span className="text-xs">{formatDateTime(row.createdAt)}</span>,
		},
	];
	if (reports.isLoading) return <Skeleton className="h-40 w-full" />;
	if (reports.error) return <p className="text-sm text-destructive">{reports.error.message}</p>;
	if (!reports.data) return null;
	return (
		<GeoPaginatedTable
			columns={columns}
			rows={reports.data.rows}
			rowKey={(row) => row.id}
			page={reports.data.page}
			totalPages={reports.data.totalPages}
			total={reports.data.total}
			onPageChange={onPageChange}
			empty={
				<GeoEmptyState title="还没有报告" description="每月初会为上月有采样数据的组织自动生成月报，也可以手动生成。" />
			}
		/>
	);
}
