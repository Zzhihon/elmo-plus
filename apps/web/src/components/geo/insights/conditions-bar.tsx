import { GEO_PLATFORM_LABELS, GEO_SURFACE_MODE_LABELS } from "@workspace/geo-domain";
import { formatDateTime } from "@/components/geo/sampling/format";
import type { MetricMeta } from "@/server/geo/metrics-core";

function Item({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="flex flex-col gap-0.5">
			<span className="text-xs text-muted-foreground">{label}</span>
			<span className="text-sm font-medium">{children}</span>
		</div>
	);
}

/** The fixed comparison conditions every figure on the page was computed under (PRD 3.7). */
export function GeoConditionsBar({ meta }: { meta: MetricMeta }) {
	return (
		<div className="grid grid-cols-2 gap-4 rounded-lg border bg-muted/30 p-4 sm:grid-cols-3 lg:grid-cols-6">
			<Item label="时间窗口（北京时间）">
				{meta.from} 至 {meta.to}
			</Item>
			<Item label="问法集版本">
				{meta.promptSet ? `${meta.promptSet.name} v${meta.promptSet.version}` : "无采样数据"}
			</Item>
			<Item label="采样方式">
				{meta.surfaceMode
					? GEO_SURFACE_MODE_LABELS[meta.surfaceMode]
					: meta.surfaceModes.map((mode) => GEO_SURFACE_MODE_LABELS[mode]).join("、") || "—"}
				{meta.platform ? ` · ${GEO_PLATFORM_LABELS[meta.platform]}` : ""}
			</Item>
			<Item label="有效样本量">
				<span className="tabular-nums">{meta.validSamples}</span>
			</Item>
			<Item label="数据更新时间">{formatDateTime(meta.updatedAt)}</Item>
			<Item label="口径 / 评估规则">
				<span className="text-xs">
					{meta.metricVersion}
					{meta.evaluatorVersions.length > 0 ? ` · ${meta.evaluatorVersions.join("、")}` : ""}
				</span>
			</Item>
		</div>
	);
}
