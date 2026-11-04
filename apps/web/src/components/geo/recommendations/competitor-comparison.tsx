import { GEO_PLATFORM_LABELS, GEO_SURFACE_MODE_LABELS, type GeoCitedContentType } from "@workspace/geo-domain";
import { GEO_CITED_CONTENT_TYPE_LABELS } from "@workspace/geo-reports/recommendations/labels";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@workspace/ui/components/table";
import { GeoEmptyState } from "@/components/geo/shell/empty-state";
import type { CompetitorComparison as Comparison } from "@/server/geo/recommendations-core";
import { formatRate } from "./labels";

function citedTypes(types: Partial<Record<GeoCitedContentType, number>>) {
	const entries = Object.entries(types)
		.filter(([type]) => type !== "OTHER")
		.sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0)) as [GeoCitedContentType, number][];
	if (entries.length === 0) return <span className="text-muted-foreground">—</span>;
	return (
		<div className="flex flex-wrap gap-1">
			{entries.map(([type, count]) => (
				<span key={type} className="rounded border bg-muted/50 px-1.5 py-0.5 text-xs">
					{GEO_CITED_CONTENT_TYPE_LABELS[type]} {count}
				</span>
			))}
		</div>
	);
}

export function CompetitorComparison({ comparison }: { comparison: Comparison }) {
	if (comparison.modes.length === 0) {
		return (
			<GeoEmptyState
				title="还没有可比较的回答"
				description="完成一轮采样并评估后，这里会显示我们和竞品分别被 AI 提到的比例。"
			/>
		);
	}
	return (
		<div className="flex flex-col gap-6">
			{comparison.modes.map((mode) => {
				const rows = [...mode.rows].sort((a, b) =>
					a.entityId === null ? -1 : b.entityId === null ? 1 : (b.mentionRate ?? -1) - (a.mentionRate ?? -1),
				);
				return (
					<div key={mode.surfaceMode} className="flex flex-col gap-2">
						{comparison.modes.length > 1 && (
							<p className="text-sm font-medium">{GEO_SURFACE_MODE_LABELS[mode.surfaceMode]}</p>
						)}
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>品牌</TableHead>
									<TableHead>被提到的比例</TableHead>
									{mode.platforms.map((platform) => (
										<TableHead key={platform}>{GEO_PLATFORM_LABELS[platform]}</TableHead>
									))}
									<TableHead>AI 引用的内容</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{rows.map((row) => (
									<TableRow key={row.entityId ?? "own"} className={row.entityId === null ? "bg-muted/40" : undefined}>
										<TableCell className="font-medium">
											{row.name}
											{row.entityId === null && <span className="ml-1 text-xs text-muted-foreground">（我们）</span>}
										</TableCell>
										<TableCell className="tabular-nums">{formatRate(row.mentionRate)}</TableCell>
										{row.byPlatform.map((entry) => (
											<TableCell key={entry.platform} className="tabular-nums text-muted-foreground">
												{entry.evaluated > 0 ? `${entry.mentioned}/${entry.evaluated}` : "—"}
											</TableCell>
										))}
										<TableCell>{citedTypes(row.citedTypes)}</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					</div>
				);
			})}
			<p className="text-xs text-muted-foreground">
				比例是各平台比例的平均值；平台列为“提到的回答数 / 有效回答数”。只统计最近 4 周同一组问题的有效回答。
			</p>
		</div>
	);
}
