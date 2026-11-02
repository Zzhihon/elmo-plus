import type { CellMetrics, CellTrend } from "@workspace/geo-reports";
import { Card, CardContent, CardHeader, CardTitle } from "@workspace/ui/components/card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@workspace/ui/components/tooltip";
import type { ReactNode } from "react";
import { GeoPlatformBadge, GeoSurfaceModeBadge } from "@/components/geo/shell/evidence-badge";
import { GeoStatusBadge } from "@/components/geo/shell/status-badge";
import { type EvidenceFilter, EvidenceLink, MetricFigure } from "./metric-figure";

function Row({ label, hint, children }: { label: string; hint: string; children: ReactNode }) {
	return (
		<div className="flex items-start justify-between gap-3 border-b py-2 last:border-b-0">
			<Tooltip>
				<TooltipTrigger render={<span className="cursor-help text-sm text-muted-foreground">{label}</span>} />
				<TooltipContent className="max-w-xs text-sm">{hint}</TooltipContent>
			</Tooltip>
			<div className="flex flex-col items-end gap-0.5 text-right text-sm">{children}</div>
		</div>
	);
}

function Note({ children }: { children: ReactNode }) {
	return <span className="text-xs text-muted-foreground">{children}</span>;
}

const TREND_TONE = {
	SUSTAINED_IMPROVEMENT: "success",
	SUSTAINED_DECLINE: "danger",
	OBSERVED_CHANGE: "info",
	NO_CHANGE: "neutral",
	INSUFFICIENT: "neutral",
} as const;

/** All eight PRD 5.2 metrics for one platform and surface mode, each linked to its samples. */
export function GeoCellMetricsCard({
	cell,
	trend,
	filter,
}: {
	cell: CellMetrics;
	trend: CellTrend | undefined;
	filter: Omit<EvidenceFilter, "platform" | "surfaceMode">;
}) {
	const evidence = { ...filter, platform: cell.platform, surfaceMode: cell.surfaceMode };
	const breakdown = cell.validSampleRate.breakdown;
	return (
		<Card>
			<CardHeader className="gap-2 pb-2">
				<CardTitle className="flex flex-wrap items-center gap-2 text-base">
					<GeoPlatformBadge platform={cell.platform} />
					<GeoSurfaceModeBadge mode={cell.surfaceMode} />
				</CardTitle>
				{trend && (
					<div className="flex flex-wrap gap-2">
						<GeoStatusBadge label={`提及：${trend.mention.label}`} tone={TREND_TONE[trend.mention.kind]} />
					</div>
				)}
			</CardHeader>
			<CardContent>
				<Row
					label="有效采样率"
					hint="有效样本 / 计划采样；被拒绝、限流、失败与进行中的采样分开列出，均不计为“未提及”。"
				>
					<MetricFigure value={cell.validSampleRate.value} />
					<Note>
						拒绝/不可用 {breakdown.refused} · 限流 {breakdown.rateLimited} · 失败 {breakdown.failed} · 截断{" "}
						{breakdown.partial}
						{breakdown.pending > 0 ? ` · 进行中 ${breakdown.pending}` : ""}
					</Note>
				</Row>
				<Row label="品牌提及率" hint="命中品牌词典别名的有效样本 / 已评估的有效样本。不代表真实用户流量份额。">
					<EvidenceLink filter={evidence}>
						<MetricFigure value={cell.mentionRate} />
					</EvidenceLink>
					{cell.pendingEvaluation > 0 && <Note>{cell.pendingEvaluation} 个有效样本待评估，未计入</Note>}
				</Row>
				<Row
					label="稳定提及问法率"
					hint="同一轮中每个问法至少取得三次有效采样，其中至少两次提及才算稳定；不足三次的问法标为样本不足，不计入。"
				>
					<MetricFigure value={cell.stableMention.value} />
					{cell.stableMention.insufficientUnits > 0 && (
						<Note>样本不足的问法 {cell.stableMention.insufficientUnits} 个</Note>
					)}
				</Row>
				<Row label="推荐率" hint="经规则或人工确认的明确正向推荐 / 已评估的有效样本。提及、对比和引用不算推荐。">
					<EvidenceLink filter={evidence}>
						<MetricFigure value={cell.recommendationRate} />
					</EvidenceLink>
					{cell.recommendationsAwaitingReview > 0 && (
						<Note>另有 {cell.recommendationsAwaitingReview} 条推荐待复核，未计入</Note>
					)}
				</Row>
				<Row label="前三率" hint="只在含有可判定排序清单的回答中计算；无排序的回答不硬造名次。">
					<MetricFigure value={cell.top3Rate} />
				</Row>
				<Row label="错误描述率" hint="经技术审核证实错误的事实断言 / 可核对断言。无法核实的陈述标为待核实，不算错误。">
					<MetricFigure value={cell.errorRate.value} />
					{cell.errorRate.awaitingTechReview > 0 && <Note>{cell.errorRate.awaitingTechReview} 条待技术审核</Note>}
				</Row>
				<Row label="引用来源" hint="规范化后的被引用 URL 按域名统计；回答没有引用时显示“不提供”。">
					{cell.citations.status === "NOT_PROVIDED" ? (
						<MetricFigure value={cell.citations.samplesWithCitations} notProvided />
					) : (
						<span className="tabular-nums">
							{cell.citations.totalCitations} 条 · 自有 {cell.citations.byOwner.OWN} · 竞品{" "}
							{cell.citations.byOwner.COMPETITOR} · 第三方 {cell.citations.byOwner.THIRD_PARTY}
						</span>
					)}
				</Row>
				<Row label="竞品覆盖" hint="各竞品在同一组有效样本中的提及占比；竞品可同时出现，合计可超过 100%。">
					{cell.competitors.length === 0 ? (
						<Note>未配置竞品</Note>
					) : (
						cell.competitors.slice(0, 3).map((competitor) => (
							<span key={competitor.entityId} className="inline-flex items-center gap-1.5">
								<span className="text-xs text-muted-foreground">{competitor.name}</span>
								<MetricFigure value={competitor.mentioned} />
							</span>
						))
					)}
				</Row>
			</CardContent>
		</Card>
	);
}
