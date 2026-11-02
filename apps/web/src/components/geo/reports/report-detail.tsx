import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { GEO_TASK_STATE_LABELS } from "@workspace/geo-domain";
import { cellLabel, type ReportSnapshot } from "@workspace/geo-reports";
import { Alert, AlertDescription, AlertTitle } from "@workspace/ui/components/alert";
import { Button, buttonVariants } from "@workspace/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@workspace/ui/components/card";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@workspace/ui/components/dialog";
import { Label } from "@workspace/ui/components/label";
import { Skeleton } from "@workspace/ui/components/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@workspace/ui/components/table";
import { Textarea } from "@workspace/ui/components/textarea";
import { type ReactNode, useState } from "react";
import { GeoCellMetricsCard } from "@/components/geo/insights/cell-metrics";
import { GeoTrendChart } from "@/components/geo/insights/trend-chart";
import { formatDateTime } from "@/components/geo/sampling/format";
import { useGeoOrganization } from "@/components/geo/sampling/use-geo-organization";
import { GeoNoDataNotice } from "@/components/geo/shell/notices";
import { useGeoViewer } from "@/components/geo/shell/use-geo-viewer";
import { errorMessage } from "@/components/geo/tasks/labels";
import { getReportFn, retryReportFn, reviewReportFn } from "@/server/geo/reports";
import { GeoReportStatusBadges, reportKeys } from "./report-list";

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
	return (
		<Card>
			<CardHeader>
				<CardTitle>{title}</CardTitle>
				{description && <CardDescription>{description}</CardDescription>}
			</CardHeader>
			<CardContent>{children}</CardContent>
		</Card>
	);
}

function Bullets({ items }: { items: readonly string[] }) {
	if (items.length === 0) return <p className="text-sm text-muted-foreground">无。</p>;
	return (
		<ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
			{items.map((item) => (
				<li key={item}>{item}</li>
			))}
		</ul>
	);
}

function ReviewDialog({
	reportId,
	decision,
	onClose,
}: {
	reportId: string;
	decision: "APPROVE" | "REJECT";
	onClose: () => void;
}) {
	const organization = useGeoOrganization();
	const queryClient = useQueryClient();
	const [note, setNote] = useState("");
	const review = useMutation({
		mutationFn: () =>
			reviewReportFn({
				data: { organizationId: organization.id, reportId, input: { decision, note: note.trim() || undefined } },
			}),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: reportKeys.all(organization.id) });
			onClose();
		},
	});
	const rejecting = decision === "REJECT";
	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>{rejecting ? "驳回报告" : "审核通过报告"}</DialogTitle>
					<DialogDescription>审核结论写入审计日志；报告内容是生成时的快照，不会因此改变。</DialogDescription>
				</DialogHeader>
				<div className="flex flex-col gap-1.5">
					<Label htmlFor="report-review-note">{rejecting ? "驳回意见（必填）" : "审核意见（可选）"}</Label>
					<Textarea id="report-review-note" rows={3} value={note} onChange={(event) => setNote(event.target.value)} />
				</div>
				{review.error && (
					<Alert variant="destructive">
						<AlertDescription>{errorMessage(review.error)}</AlertDescription>
					</Alert>
				)}
				<DialogFooter>
					<Button variant="outline" onClick={onClose}>
						取消
					</Button>
					<Button
						variant={rejecting ? "destructive" : "default"}
						disabled={review.isPending || (rejecting && note.trim().length < 2)}
						onClick={() => review.mutate()}
					>
						{rejecting ? "驳回" : "通过"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function SnapshotBody({ snapshot }: { snapshot: ReportSnapshot }) {
	const organization = useGeoOrganization();
	const promptSet = snapshot.conditions.promptSet;
	const from = snapshot.period.start;
	const filterOf = (path: string) => {
		const params = new URLSearchParams(path.split("?")[1] ?? "");
		return { promptSetId: params.get("promptSetId"), from: params.get("from") ?? "", to: params.get("to") ?? "" };
	};
	const linkFilter = snapshot.evidenceLinks[0]
		? filterOf(snapshot.evidenceLinks[0].path)
		: { promptSetId: null, from, to: from };
	const inputs = snapshot.businessInputs;
	return (
		<div className="flex flex-col gap-4">
			<Section title="方法与口径" description={`指标口径 ${snapshot.metricVersion}`}>
				<div className="mb-3 grid grid-cols-1 gap-2 text-sm sm:grid-cols-3">
					<div>统计周期：{snapshot.period.label}（北京时间）</div>
					<div>问法集：{promptSet ? `${promptSet.name} v${promptSet.version}` : "未限定"}</div>
					<div>评估规则：{snapshot.conditions.evaluatorVersions.join("、") || "—"}</div>
				</div>
				<Bullets items={snapshot.methodology} />
			</Section>

			<Section
				title="样本"
				description={`计划 ${snapshot.insights.totals.planned} · 有效 ${snapshot.insights.totals.valid} · 已评估 ${snapshot.insights.totals.evaluated} · 待评估 ${snapshot.insights.totals.pendingEvaluation}`}
			>
				{snapshot.insights.noData && <GeoNoDataNotice />}
				<div className="mt-3 grid gap-4 lg:grid-cols-2">
					{snapshot.insights.cells.map((cell) => (
						<GeoCellMetricsCard
							key={`${cell.platform}-${cell.surfaceMode}`}
							cell={cell}
							trend={snapshot.insights.trends.find(
								(trend) => trend.platform === cell.platform && trend.surfaceMode === cell.surfaceMode,
							)}
							filter={linkFilter}
						/>
					))}
				</div>
				<p className="mt-3 text-xs text-muted-foreground">
					点击比率会打开当前证据库中对应条件的样本；报告中的数字以生成时的评估版本为准（共引用{" "}
					{snapshot.evaluationRefs.length} 个评估版本）。
				</p>
			</Section>

			{snapshot.insights.trends.length > 0 && (
				<Section title="趋势" description="按轮次；虚线为比较条件断点，断点前后不能直接比较。">
					<div className="grid gap-4 lg:grid-cols-2">
						{snapshot.insights.trends.map((trend) => (
							<GeoTrendChart key={`${trend.platform}-${trend.surfaceMode}`} trend={trend} />
						))}
					</div>
				</Section>
			)}

			<Section title="发现">
				<Bullets items={snapshot.findings} />
			</Section>

			<Section title="已执行任务" description="本期登记发布或已验证的优化工单。">
				{snapshot.tasks.executed.length === 0 ? (
					<p className="text-sm text-muted-foreground">本期没有登记发布的工单。</p>
				) : (
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>工单</TableHead>
								<TableHead>状态</TableHead>
								<TableHead>发布地址</TableHead>
								<TableHead>发布时间</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{snapshot.tasks.executed.map((task) => (
								<TableRow key={task.id}>
									<TableCell>
										<Link
											to="/app/org/$org/geo/tasks/$id"
											params={{ org: organization.slug, id: task.id }}
											className="hover:underline"
										>
											{task.title}
										</Link>
									</TableCell>
									<TableCell>{GEO_TASK_STATE_LABELS[task.state]}</TableCell>
									<TableCell className="max-w-64 truncate text-xs">{task.publishedUrl ?? "—"}</TableCell>
									<TableCell className="text-xs">{formatDateTime(task.publishedAt)}</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				)}
			</Section>

			<Section title="投入、中间结果与业务结果">
				<Bullets
					items={[
						`已核验资料：已审核事实 ${inputs.approvedAssertions} 条，其中本期新审核 ${inputs.approvedInPeriod} 条。`,
						`已发布内容：本期登记发布 ${inputs.publishedContentInPeriod} 篇内容，${inputs.tasksPublishedInPeriod} 个工单登记发布。`,
						...snapshot.intermediateResults,
						...snapshot.businessOutcomes,
					]}
				/>
			</Section>

			<Section title="未完成风险">
				<Bullets items={snapshot.risks} />
			</Section>

			<Section title="下期计划">
				<Bullets items={snapshot.nextPlan} />
				{snapshot.notes && <p className="mt-3 whitespace-pre-wrap text-sm">补充说明：{snapshot.notes}</p>}
			</Section>

			<Section title="证据链接" description="按平台与采样方式打开计算所用条件下的有效样本。">
				<ul className="flex flex-col gap-1 text-sm">
					{snapshot.evidenceLinks.map((link) => (
						<li key={link.path}>
							<a href={link.path} className="hover:underline">
								{cellLabel(link.platform, link.surfaceMode)}
							</a>
						</li>
					))}
				</ul>
			</Section>
		</div>
	);
}

type ReportData = Awaited<ReturnType<typeof getReportFn>>;

function ReportActions({
	data,
	onReview,
	onRetry,
	retrying,
}: {
	data: ReportData;
	onReview: (decision: "APPROVE" | "REJECT") => void;
	onRetry: () => void;
	retrying: boolean;
}) {
	const organization = useGeoOrganization();
	const viewer = useGeoViewer();
	const download = (format: "pdf" | "csv") =>
		`/api/geo/${encodeURIComponent(organization.slug)}/reports/${data.id}/${format}`;
	const reviewable = data.status === "SUCCEEDED" && data.reviewStatus === "PENDING" && viewer.can("report.review");
	const retryable = data.status === "FAILED" && viewer.can("report.generate");
	return (
		<div className="flex flex-wrap gap-2">
			{data.hasPdf && (
				<a href={download("pdf")} className={buttonVariants({ variant: "outline" })} download>
					下载 PDF
				</a>
			)}
			{data.hasCsv && (
				<a href={download("csv")} className={buttonVariants({ variant: "outline" })} download>
					下载 CSV
				</a>
			)}
			{reviewable && (
				<>
					<Button variant="outline" onClick={() => onReview("REJECT")}>
						驳回
					</Button>
					<Button onClick={() => onReview("APPROVE")}>审核通过</Button>
				</>
			)}
			{retryable && (
				<Button onClick={onRetry} disabled={retrying}>
					重新生成
				</Button>
			)}
		</div>
	);
}

function ReportStatusNotes({ data }: { data: ReportData }) {
	return (
		<>
			{data.status === "FAILED" && (
				<Alert variant="destructive">
					<AlertTitle>生成失败</AlertTitle>
					<AlertDescription>{data.errorSummary ?? "报告生成失败"}</AlertDescription>
				</Alert>
			)}
			{(data.status === "QUEUED" || data.status === "RUNNING") && (
				<Alert>
					<AlertTitle>报告生成中</AlertTitle>
					<AlertDescription>后台正在汇总指标并生成 PDF 与 CSV，页面会自动刷新。</AlertDescription>
				</Alert>
			)}
			{data.reviewStatus !== "PENDING" && data.reviewedAt && (
				<p className="text-sm text-muted-foreground">
					{data.reviewStatus === "APPROVED" ? "审核通过" : "已驳回"}：{data.reviewedBy}，
					{formatDateTime(data.reviewedAt)}
					{data.reviewNote ? `。意见：${data.reviewNote}` : ""}
				</p>
			)}
		</>
	);
}

export function GeoReportDetail({ reportId }: { reportId: string }) {
	const organization = useGeoOrganization();
	const queryClient = useQueryClient();
	const [reviewing, setReviewing] = useState<"APPROVE" | "REJECT" | null>(null);
	const report = useQuery({
		queryKey: reportKeys.detail(organization.id, reportId),
		queryFn: () => getReportFn({ data: { organizationId: organization.id, reportId } }),
		refetchInterval: (query) =>
			query.state.data?.status === "QUEUED" || query.state.data?.status === "RUNNING" ? 5000 : false,
	});
	const retry = useMutation({
		mutationFn: () => retryReportFn({ data: { organizationId: organization.id, reportId } }),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: reportKeys.all(organization.id) }),
	});
	if (report.error) return <p className="text-sm text-destructive">{report.error.message}</p>;
	if (!report.data) return <Skeleton className="h-96 w-full" />;
	const data = report.data;

	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div className="flex flex-col gap-1">
					<h2 className="text-lg font-semibold">{data.title}</h2>
					<GeoReportStatusBadges report={data} />
				</div>
				<ReportActions data={data} onReview={setReviewing} onRetry={() => retry.mutate()} retrying={retry.isPending} />
			</div>
			<ReportStatusNotes data={data} />
			{retry.error && <p className="text-sm text-destructive">{errorMessage(retry.error)}</p>}
			{data.snapshot && <SnapshotBody snapshot={data.snapshot} />}
			<Section title="导出历史" description="每次下载都会写入审计日志。">
				{data.exports.length === 0 ? (
					<p className="text-sm text-muted-foreground">尚未导出。</p>
				) : (
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>格式</TableHead>
								<TableHead>操作人</TableHead>
								<TableHead>时间</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{data.exports.map((entry) => (
								<TableRow key={`${entry.actorId}-${entry.at}`}>
									<TableCell className="uppercase">{entry.format}</TableCell>
									<TableCell className="text-xs">{entry.actorId}</TableCell>
									<TableCell className="text-xs">{formatDateTime(entry.at)}</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				)}
			</Section>
			{reviewing && <ReviewDialog reportId={data.id} decision={reviewing} onClose={() => setReviewing(null)} />}
		</div>
	);
}
