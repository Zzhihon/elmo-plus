import { type CellTrend, CONDITION_LABELS, chinaDate } from "@workspace/geo-reports";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@workspace/ui/components/card";
import { type ChartConfig, ChartContainer, ChartTooltip } from "@workspace/ui/components/chart";
import { CartesianGrid, Line, LineChart, ReferenceLine, XAxis, YAxis } from "recharts";
import { GeoPlatformBadge, GeoSurfaceModeBadge } from "@/components/geo/shell/evidence-badge";
import { GeoStatusBadge } from "@/components/geo/shell/status-badge";

const config: ChartConfig = {
	mention: { label: "品牌提及率", color: "#2563eb" },
	recommendation: { label: "推荐率", color: "#059669" },
};

interface Point {
	label: string;
	mention: number | null;
	recommendation: number | null;
	samples: number;
	lowSample: boolean;
	breakpoint: string[];
}

function toPoints(trend: CellTrend): Point[] {
	return trend.points.map((point, index) => ({
		label: `${index + 1}. ${chinaDate(new Date(point.startedAt)).slice(5)}`,
		mention: point.mentionRate.status === "OK" ? Math.round(point.mentionRate.rate * 1000) / 10 : null,
		recommendation:
			point.recommendationRate.status === "OK" ? Math.round(point.recommendationRate.rate * 1000) / 10 : null,
		samples: point.mentionRate.denominator,
		lowSample: point.mentionRate.status === "OK" && point.mentionRate.lowSample,
		breakpoint: point.breakpoint.map((key) => CONDITION_LABELS[key]),
	}));
}

/**
 * One line per platform and surface mode, a point per sampling round. A round without
 * valid samples is a gap, not zero, and a dashed line marks where a comparison condition changed.
 */
export function GeoTrendChart({ trend }: { trend: CellTrend }) {
	const points = toPoints(trend);
	const breaks = points.filter((point) => point.breakpoint.length > 0);
	return (
		<Card>
			<CardHeader className="gap-1 pb-2">
				<CardTitle className="flex flex-wrap items-center gap-2 text-sm font-medium">
					<GeoPlatformBadge platform={trend.platform} />
					<GeoSurfaceModeBadge mode={trend.surfaceMode} />
					<span>按轮次</span>
				</CardTitle>
				<CardDescription className="flex flex-wrap gap-2">
					<span>提及：{trend.mention.label}</span>
					<span>推荐：{trend.recommendation.label}</span>
				</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-2">
				{points.length === 0 ? (
					<p className="text-sm text-muted-foreground">该条件下没有采样轮次。</p>
				) : (
					<ChartContainer config={config} className="aspect-auto h-[220px] w-full">
						<LineChart data={points} margin={{ top: 16, right: 12, left: -12, bottom: 0 }}>
							<CartesianGrid vertical={false} strokeDasharray="3 3" />
							<XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} tick={{ fontSize: 11 }} />
							<YAxis
								domain={[0, 100]}
								ticks={[0, 25, 50, 75, 100]}
								tickLine={false}
								axisLine={false}
								tick={{ fontSize: 11 }}
								tickFormatter={(value) => `${value}%`}
							/>
							{breaks.map((point) => (
								<ReferenceLine
									key={point.label}
									x={point.label}
									stroke="#d97706"
									strokeDasharray="4 4"
									label={{ value: "断点", position: "top", fontSize: 11, fill: "#b45309" }}
								/>
							))}
							<ChartTooltip
								isAnimationActive={false}
								content={({ active, payload }) => {
									const point = payload?.[0]?.payload as Point | undefined;
									if (!active || !point) return null;
									return (
										<div className="grid min-w-[12rem] gap-1 rounded-lg border bg-background px-2.5 py-1.5 text-xs shadow-xl">
											<div className="font-medium">第 {point.label}</div>
											<div>品牌提及率：{point.mention === null ? "数据不足" : `${point.mention}%`}</div>
											<div>推荐率：{point.recommendation === null ? "数据不足" : `${point.recommendation}%`}</div>
											<div className="text-muted-foreground">
												已评估有效样本 {point.samples}
												{point.lowSample ? "（低样本）" : ""}
											</div>
											{point.breakpoint.length > 0 && (
												<div className="text-amber-700">条件变化：{point.breakpoint.join("、")}</div>
											)}
										</div>
									);
								}}
							/>
							<Line dataKey="mention" stroke="var(--color-mention)" strokeWidth={2} connectNulls={false} />
							<Line
								dataKey="recommendation"
								stroke="var(--color-recommendation)"
								strokeWidth={2}
								connectNulls={false}
							/>
						</LineChart>
					</ChartContainer>
				)}
				<div className="flex flex-wrap gap-2">
					{points
						.filter((point) => point.lowSample)
						.map((point) => (
							<GeoStatusBadge key={`low-${point.label}`} label={`第 ${point.label} 轮低样本`} tone="warning" />
						))}
					{breaks.map((point) => (
						<GeoStatusBadge
							key={`break-${point.label}`}
							label={`第 ${point.label} 轮起：${point.breakpoint.join("、")}变化`}
							tone="warning"
						/>
					))}
				</div>
			</CardContent>
		</Card>
	);
}
