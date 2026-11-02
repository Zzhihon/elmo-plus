import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Alert, AlertDescription, AlertTitle } from "@workspace/ui/components/alert";
import { Skeleton } from "@workspace/ui/components/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@workspace/ui/components/tabs";
import { GeoReviewPool } from "@/components/geo/review/review-pool";
import { useGeoOrganization } from "@/components/geo/sampling/use-geo-organization";
import { GeoNoDataNotice } from "@/components/geo/shell/notices";
import { getInsightsFn } from "@/server/geo/metrics";
import type { MetricQuery } from "@/server/geo/metrics-core";
import { GeoCitationSources, GeoCompetitorComparison, GeoErrorList } from "./breakdowns";
import { GeoCellMetricsCard } from "./cell-metrics";
import { GeoConditionsBar } from "./conditions-bar";
import { GeoInsightFilters } from "./insight-filters";
import { GeoGapList, GeoQuestionMatrix } from "./question-matrix";
import { type InsightSearch, type InsightTab, insightKeys } from "./search";
import { GeoTrendChart } from "./trend-chart";

export function queryOf(search: InsightSearch): MetricQuery {
	return {
		from: search.from,
		to: search.to,
		promptSetId: search.promptSetId,
		platform: search.platform,
		surfaceMode: search.surfaceMode,
	};
}

export function GeoInsightsView({
	search,
	onChange,
}: {
	search: InsightSearch;
	onChange: (next: Partial<InsightSearch>) => void;
}) {
	const organization = useGeoOrganization();
	const query = queryOf(search);
	const result = useQuery({
		queryKey: insightKeys.insights(organization.id, query),
		queryFn: () => getInsightsFn({ data: { organizationId: organization.id, query } }),
		placeholderData: keepPreviousData,
	});
	const data = result.data;
	const tab: InsightTab = search.tab ?? "platforms";
	const filter = data ? { promptSetId: data.meta.promptSet?.id ?? null, from: data.meta.from, to: data.meta.to } : null;
	const resolvedQuery = data
		? { ...query, promptSetId: data.meta.promptSet?.id, from: data.meta.from, to: data.meta.to }
		: query;
	const lowSampleCells = data?.insights.cells.filter(
		(cell) => cell.mentionRate.status === "OK" && cell.mentionRate.lowSample,
	);

	return (
		<div className="flex flex-col gap-4">
			<GeoInsightFilters search={search} meta={data?.meta} onChange={onChange} />
			{result.error && <p className="text-sm text-destructive">{result.error.message}</p>}
			{!data && !result.error && <Skeleton className="h-96 w-full" />}
			{data && filter && (
				<>
					<GeoConditionsBar meta={data.meta} />
					{data.insights.noData && <GeoNoDataNotice />}
					{lowSampleCells && lowSampleCells.length > 0 && (
						<Alert>
							<AlertTitle>低样本量</AlertTitle>
							<AlertDescription>
								{lowSampleCells.length} 个平台/采样方式的已评估有效样本少于 20
								个，相关比率已标“低样本”，变化只能视为观察。
							</AlertDescription>
						</Alert>
					)}
					<Tabs value={tab} onValueChange={(value) => onChange({ tab: value as InsightTab, page: undefined })}>
						<TabsList className="flex-wrap">
							<TabsTrigger value="platforms">平台趋势</TabsTrigger>
							<TabsTrigger value="questions">问题矩阵</TabsTrigger>
							<TabsTrigger value="competitors">竞品比较</TabsTrigger>
							<TabsTrigger value="citations">引用来源</TabsTrigger>
							<TabsTrigger value="errors">错误描述清单</TabsTrigger>
							<TabsTrigger value="review">复核池</TabsTrigger>
						</TabsList>
						<TabsContent value="platforms" className="mt-3 flex flex-col gap-4">
							<p className="text-sm text-muted-foreground">
								每个平台与采样方式分开计算，不做合并；点击比率可查看计算所用的有效样本。
							</p>
							<div className="grid gap-4 lg:grid-cols-2">
								{data.insights.cells.map((cell) => (
									<GeoCellMetricsCard
										key={`${cell.platform}-${cell.surfaceMode}`}
										cell={cell}
										trend={data.insights.trends.find(
											(trend) => trend.platform === cell.platform && trend.surfaceMode === cell.surfaceMode,
										)}
										filter={filter}
									/>
								))}
							</div>
							<div className="grid gap-4 lg:grid-cols-2">
								{data.insights.trends.map((trend) => (
									<GeoTrendChart key={`${trend.platform}-${trend.surfaceMode}`} trend={trend} />
								))}
							</div>
						</TabsContent>
						<TabsContent value="questions" className="mt-3 flex flex-col gap-4">
							<GeoQuestionMatrix insights={data.insights} filter={filter} />
							<h3 className="text-base font-semibold">缺口</h3>
							<GeoGapList
								gaps={data.insights.gaps}
								competitors={data.competitors}
								promptSetId={data.meta.promptSet?.id ?? null}
							/>
						</TabsContent>
						<TabsContent value="competitors" className="mt-3">
							<GeoCompetitorComparison insights={data.insights} filter={filter} />
						</TabsContent>
						<TabsContent value="citations" className="mt-3">
							<GeoCitationSources insights={data.insights} />
						</TabsContent>
						<TabsContent value="errors" className="mt-3">
							<GeoErrorList query={resolvedQuery} />
						</TabsContent>
						<TabsContent value="review" className="mt-3">
							<GeoReviewPool page={search.page ?? 1} onPageChange={(page) => onChange({ page })} />
						</TabsContent>
					</Tabs>
				</>
			)}
		</div>
	);
}
