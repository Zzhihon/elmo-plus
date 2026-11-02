import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { GEO_SURFACE_MODE_LABELS } from "@workspace/geo-domain";
import { buttonVariants } from "@workspace/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@workspace/ui/components/card";
import { Checkbox } from "@workspace/ui/components/checkbox";
import { Skeleton } from "@workspace/ui/components/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@workspace/ui/components/table";
import type { ReactNode } from "react";
import { useState } from "react";
import { GeoConditionsBar } from "@/components/geo/insights/conditions-bar";
import { EvidenceLink, SummaryFigure } from "@/components/geo/insights/metric-figure";
import { GeoGapList } from "@/components/geo/insights/question-matrix";
import { insightKeys } from "@/components/geo/insights/search";
import { GeoTrendChart } from "@/components/geo/insights/trend-chart";
import { GeoReviewPool } from "@/components/geo/review/review-pool";
import { useGeoOrganization } from "@/components/geo/sampling/use-geo-organization";
import { GeoEmptyState } from "@/components/geo/shell/empty-state";
import { GeoPlatformBadge, GeoSurfaceModeBadge } from "@/components/geo/shell/evidence-badge";
import { GeoNoDataNotice } from "@/components/geo/shell/notices";
import { getOverviewFn } from "@/server/geo/metrics";

function Stat({ title, children, footer }: { title: string; children: ReactNode; footer?: ReactNode }) {
	return (
		<Card>
			<CardHeader className="pb-2">
				<CardDescription>{title}</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-1">
				<div>{children}</div>
				{footer && <div className="text-xs text-muted-foreground">{footer}</div>}
			</CardContent>
		</Card>
	);
}

const PENDING_ROW = "flex items-center justify-between rounded-md border px-3 py-2 text-sm hover:bg-muted/50";

function PendingRow({ label, value }: { label: string; value: number }) {
	return (
		<>
			<span>{label}</span>
			<span className="font-semibold tabular-nums">{value}</span>
		</>
	);
}

export function GeoOverviewView() {
	const organization = useGeoOrganization();
	const [poolPage, setPoolPage] = useState(1);
	const [crossMode, setCrossMode] = useState(false);
	const overview = useQuery({
		queryKey: insightKeys.overview(organization.id, crossMode),
		queryFn: () => getOverviewFn({ data: { organizationId: organization.id, crossMode } }),
		placeholderData: keepPreviousData,
	});
	if (overview.error) return <p className="text-sm text-destructive">{overview.error.message}</p>;
	if (!overview.data) return <Skeleton className="h-96 w-full" />;
	const { meta, insights, recent, pending, competitors } = overview.data;
	const p0Gaps = insights.gaps.filter((gap) => gap.priority === "P0");

	return (
		<div className="flex flex-col gap-6">
			<GeoConditionsBar meta={meta} />
			{insights.noData && <GeoNoDataNotice />}

			{insights.overview.bySurfaceMode.map((mode) => (
				<section key={mode.surfaceMode} className="flex flex-col gap-3">
					<h2 className="text-lg font-semibold">{GEO_SURFACE_MODE_LABELS[mode.surfaceMode]}</h2>
					<div className="grid gap-4 sm:grid-cols-3">
						<Stat title="品牌提及率（内部概览）" footer={mode.mention.note}>
							<SummaryFigure value={mode.mention.value} />
						</Stat>
						<Stat title="推荐率（内部概览）" footer="仅计规则或人工确认的明确推荐，同一采样方式内跨平台等权平均。">
							<SummaryFigure value={mode.recommendation.value} />
						</Stat>
						<Stat title="有效样本" footer={`计划 ${mode.planned} 次 · 待评估 ${mode.pendingEvaluation}`}>
							<span className="text-2xl font-semibold tabular-nums">{mode.valid}</span>
						</Stat>
					</div>
				</section>
			))}

			<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
				<Stat title="P0 缺口" footer="最新一轮中三次有效采样里提及不足两次的 P0 问法 × 平台">
					<span className="text-2xl font-semibold tabular-nums">{p0Gaps.length}</span>
				</Stat>
				{insights.overview.crossMode && (
					<>
						<Stat title="品牌提及率（跨采样方式汇总）" footer={insights.overview.crossMode.mention.note}>
							<SummaryFigure value={insights.overview.crossMode.mention.value} />
						</Stat>
						<Stat title="推荐率（跨采样方式汇总）" footer={insights.overview.crossMode.recommendation.note}>
							<SummaryFigure value={insights.overview.crossMode.recommendation.value} />
						</Stat>
					</>
				)}
			</div>
			<label className="flex items-center gap-2 text-sm text-muted-foreground" htmlFor="overview-cross-mode">
				<Checkbox
					id="overview-cross-mode"
					checked={crossMode}
					onCheckedChange={(checked) => setCrossMode(checked === true)}
				/>
				显示跨采样方式汇总（混合不同口径，仅供内部参考）
			</label>

			<section className="flex flex-col gap-3">
				<div className="flex items-center justify-between">
					<h2 className="text-lg font-semibold">总体趋势（按平台与采样方式分开）</h2>
					<Link
						to="/app/org/$org/geo/insights"
						params={{ org: organization.slug }}
						className={buttonVariants({ variant: "outline", size: "sm" })}
					>
						查看诊断分析
					</Link>
				</div>
				{insights.trends.length === 0 ? (
					<GeoEmptyState title="还没有采样数据" description="冻结问法集并完成一轮采样后，这里会按平台显示趋势。" />
				) : (
					<div className="grid gap-4 lg:grid-cols-2">
						{insights.trends.map((trend) => (
							<GeoTrendChart key={`${trend.platform}-${trend.surfaceMode}`} trend={trend} />
						))}
					</div>
				)}
			</section>

			<section className="flex flex-col gap-3">
				<h2 className="text-lg font-semibold">P0 缺口</h2>
				<GeoGapList gaps={p0Gaps} competitors={competitors} promptSetId={meta.promptSet?.id ?? null} limit={10} />
			</section>

			<div className="grid gap-6 lg:grid-cols-3">
				<section className="flex flex-col gap-3 lg:col-span-2">
					<h2 className="text-lg font-semibold">
						近七日结果
						<span className="ml-2 text-sm font-normal text-muted-foreground">
							{recent.from} 至 {recent.to}
						</span>
					</h2>
					{recent.cells.length === 0 ? (
						<GeoEmptyState title="近七日没有采样" />
					) : (
						<div className="rounded-lg border">
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>平台 / 方式</TableHead>
										<TableHead className="text-right">采样</TableHead>
										<TableHead className="text-right">有效</TableHead>
										<TableHead className="text-right">未取得完整回答</TableHead>
										<TableHead className="text-right">提及（已评估）</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{recent.cells.map((cell) => (
										<TableRow key={`${cell.platform}-${cell.surfaceMode}`}>
											<TableCell>
												<div className="flex flex-wrap gap-1.5">
													<GeoPlatformBadge platform={cell.platform} />
													<GeoSurfaceModeBadge mode={cell.surfaceMode} />
												</div>
											</TableCell>
											<TableCell className="text-right tabular-nums">{cell.total}</TableCell>
											<TableCell className="text-right tabular-nums">{cell.valid}</TableCell>
											<TableCell className="text-right tabular-nums">{cell.notValid}</TableCell>
											<TableCell className="text-right tabular-nums">
												{cell.evaluated === 0 ? (
													<span className="text-muted-foreground">数据不足</span>
												) : (
													<EvidenceLink
														filter={{
															platform: cell.platform,
															surfaceMode: cell.surfaceMode,
															from: recent.from,
															to: recent.to,
														}}
													>
														{cell.mentioned}/{cell.evaluated}
													</EvidenceLink>
												)}
											</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>
						</div>
					)}
				</section>
				<section className="flex flex-col gap-3">
					<h2 className="text-lg font-semibold">待审核</h2>
					<div className="flex flex-col gap-2">
						<Link
							to="/app/org/$org/geo/insights"
							params={{ org: organization.slug }}
							search={{ tab: "review" }}
							className={PENDING_ROW}
						>
							<PendingRow label="评估复核池" value={pending.reviewPool} />
						</Link>
						<Link to="/app/org/$org/geo/reports" params={{ org: organization.slug }} className={PENDING_ROW}>
							<PendingRow label="待审核报告" value={pending.reportsToReview} />
						</Link>
						<Link to="/app/org/$org/geo/tasks" params={{ org: organization.slug }} className={PENDING_ROW}>
							<PendingRow label="未完成工单" value={pending.openTasks} />
						</Link>
						<Link to="/app/org/$org/geo/sampling" params={{ org: organization.slug }} className={PENDING_ROW}>
							<PendingRow label="进行中的采样批次" value={pending.runningBatches} />
						</Link>
					</div>
				</section>
			</div>

			{pending.reviewPool > 0 && (
				<section className="flex flex-col gap-3">
					<CardTitle className="text-lg">复核池（优先级最高的条目）</CardTitle>
					<GeoReviewPool page={poolPage} onPageChange={setPoolPage} limit={5} />
				</section>
			)}
			<p className="text-xs text-muted-foreground">
				统计口径：
				{meta.promptSet ? `固定问法集“${meta.promptSet.name}” v${meta.promptSet.version}` : "当前窗口无问法集样本"}
				，指标默认按平台与采样方式分开计算，不跨采样方式汇总；概览中同一采样方式内的跨平台数字为等权平均，仅供内部参考。测试样本为固定问法集合，不代表平台真实用户分布。
			</p>
		</div>
	);
}
