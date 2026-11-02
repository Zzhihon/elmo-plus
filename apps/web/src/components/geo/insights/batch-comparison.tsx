import { useQuery } from "@tanstack/react-query";
import { GEO_PLATFORM_LABELS, GEO_SURFACE_MODE_LABELS } from "@workspace/geo-domain";
import { Alert, AlertDescription, AlertTitle } from "@workspace/ui/components/alert";
import { Skeleton } from "@workspace/ui/components/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@workspace/ui/components/table";
import { useGeoOrganization } from "@/components/geo/sampling/use-geo-organization";
import { GeoEmptyState } from "@/components/geo/shell/empty-state";
import { compareBatchesFn } from "@/server/geo/metrics";
import { MetricFigure } from "./metric-figure";
import { insightKeys } from "./search";

function delta(value: number | null): string {
	if (value === null) return "—";
	return `${value > 0 ? "+" : ""}${value} 个百分点`;
}

/**
 * A baseline round against a retest round under the same conditions (UAT-14), for the
 * task retest view: per platform and surface mode, on the questions both rounds sampled.
 */
export function GeoBatchComparison({
	beforeBatchId,
	afterBatchId,
	promptId,
}: {
	beforeBatchId: string;
	afterBatchId: string;
	promptId?: string | null;
}) {
	const organization = useGeoOrganization();
	const query = { before: beforeBatchId, after: afterBatchId, promptId: promptId ?? undefined };
	const comparison = useQuery({
		queryKey: insightKeys.comparison(organization.id, query),
		queryFn: () => compareBatchesFn({ data: { organizationId: organization.id, query } }),
	});
	if (comparison.isLoading) return <Skeleton className="h-40 w-full" />;
	if (comparison.error) return <p className="text-sm text-destructive">{comparison.error.message}</p>;
	const data = comparison.data;
	if (!data) return null;
	if (data.rows.length === 0) return <GeoEmptyState title="两个批次都没有可对比的采样结果" />;
	return (
		<div className="flex flex-col gap-3">
			<Alert variant={data.sameConditions ? "default" : "destructive"}>
				<AlertTitle>{data.sameConditions ? "两轮条件一致" : "两轮条件不一致"}</AlertTitle>
				<AlertDescription>
					{data.reading}
					{data.excludedPromptIds.length > 0 &&
						`另有 ${data.excludedPromptIds.length} 个问法只在一轮中采样，未参与对比。`}
				</AlertDescription>
			</Alert>
			<div className="rounded-lg border">
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>平台 / 方式</TableHead>
							<TableHead>提及（前）</TableHead>
							<TableHead>提及（后）</TableHead>
							<TableHead>变化</TableHead>
							<TableHead>推荐（前）</TableHead>
							<TableHead>推荐（后）</TableHead>
							<TableHead>变化</TableHead>
							<TableHead>条件差异</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{data.rows.map((row) => (
							<TableRow key={`${row.platform}-${row.surfaceMode}`}>
								<TableCell className="whitespace-nowrap">
									{GEO_PLATFORM_LABELS[row.platform]} · {GEO_SURFACE_MODE_LABELS[row.surfaceMode]}
								</TableCell>
								<TableCell>
									<MetricFigure value={row.before.mentionRate} />
								</TableCell>
								<TableCell>
									<MetricFigure value={row.after.mentionRate} />
								</TableCell>
								<TableCell className="tabular-nums">{delta(row.mentionDelta)}</TableCell>
								<TableCell>
									<MetricFigure value={row.before.recommendationRate} />
								</TableCell>
								<TableCell>
									<MetricFigure value={row.after.recommendationRate} />
								</TableCell>
								<TableCell className="tabular-nums">{delta(row.recommendationDelta)}</TableCell>
								<TableCell className="text-xs">{row.conditionChanges.join("、") || "无"}</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			</div>
		</div>
	);
}
