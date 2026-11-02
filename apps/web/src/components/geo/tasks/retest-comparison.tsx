import {
	GEO_PLATFORM_LABELS,
	GEO_SURFACE_MODE_LABELS,
	type GeoPlatform,
	type GeoSurfaceMode,
} from "@workspace/geo-domain";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@workspace/ui/components/table";
import { GeoEmptyState } from "@/components/geo/shell/empty-state";
import { GEO_MIN_VALID_SAMPLES, GeoLowSampleNotice } from "@/components/geo/shell/notices";
import type { RetestComparisonRow } from "@/server/geo/tasks-core";

function rate(part: number, whole: number): string {
	if (whole === 0) return "无数据";
	return `${part}/${whole}（${Math.round((part / whole) * 100)}%）`;
}

/**
 * Per platform and surface mode, never pooled. Each rate shows its counts, because
 * a handful of samples moving is an observation, not proof the change worked.
 */
export function GeoRetestComparison({ rows }: { rows: RetestComparisonRow[] | null }) {
	if (!rows)
		return (
			<GeoEmptyState title="尚未关联前后批次" description="关联基线批次和复测批次后，这里按平台与采样方式对比。" />
		);
	if (rows.length === 0) return <GeoEmptyState title="两个批次都没有可对比的采样结果" />;
	const smallest = Math.min(...rows.flatMap((row) => [row.before.evaluated, row.after.evaluated]));
	return (
		<div className="flex flex-col gap-3">
			{smallest < GEO_MIN_VALID_SAMPLES && <GeoLowSampleNotice validCount={smallest} />}
			<div className="rounded-lg border">
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>平台</TableHead>
							<TableHead>采样方式</TableHead>
							<TableHead>品牌提及（前）</TableHead>
							<TableHead>品牌提及（后）</TableHead>
							<TableHead>明确推荐（前）</TableHead>
							<TableHead>明确推荐（后）</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{rows.map((row) => (
							<TableRow key={`${row.platform}-${row.surfaceMode}`}>
								<TableCell>{GEO_PLATFORM_LABELS[row.platform as GeoPlatform] ?? row.platform}</TableCell>
								<TableCell>{GEO_SURFACE_MODE_LABELS[row.surfaceMode as GeoSurfaceMode] ?? row.surfaceMode}</TableCell>
								<TableCell className="tabular-nums">{rate(row.before.mentioned, row.before.evaluated)}</TableCell>
								<TableCell className="tabular-nums">{rate(row.after.mentioned, row.after.evaluated)}</TableCell>
								<TableCell className="tabular-nums">{rate(row.before.recommended, row.before.evaluated)}</TableCell>
								<TableCell className="tabular-nums">{rate(row.after.recommended, row.after.evaluated)}</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			</div>
			<p className="text-xs text-muted-foreground">
				分母为已评估的有效样本；失败、不可用的采样不计入。同一问法的随机波动不能证明因果关系，至少连续两轮同向变化再考虑判定改善。
			</p>
		</div>
	);
}
