import {
	GEO_PLATFORM_LABELS,
	GEO_PLATFORMS,
	GEO_SURFACE_MODE_LABELS,
	GEO_SURFACE_MODES,
	type GeoPlatform,
	type GeoSurfaceMode,
} from "@workspace/geo-domain";
import { Input } from "@workspace/ui/components/input";
import { Label } from "@workspace/ui/components/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@workspace/ui/components/select";
import type { MetricMeta } from "@/server/geo/metrics-core";
import type { InsightSearch } from "./search";

const ALL = "ALL";

function Choice<T extends string>({
	label,
	value,
	options,
	allLabel,
	onChange,
	className,
}: {
	label: string;
	value: T | undefined;
	options: { value: T; label: string }[];
	allLabel?: string;
	onChange: (value: T | undefined) => void;
	className?: string;
}) {
	const items: Record<string, string> = Object.fromEntries(options.map((option) => [option.value, option.label]));
	if (allLabel) items[ALL] = allLabel;
	return (
		<div className="flex flex-col gap-1">
			<Label className="text-xs text-muted-foreground">{label}</Label>
			<Select
				items={items}
				value={value ?? (allLabel ? ALL : null)}
				onValueChange={(next) => onChange(next === ALL || next === null ? undefined : (next as T))}
			>
				<SelectTrigger className={className ?? "w-40"} aria-label={label}>
					<SelectValue placeholder="请选择" />
				</SelectTrigger>
				<SelectContent>
					{allLabel && <SelectItem value={ALL}>{allLabel}</SelectItem>}
					{options.map((option) => (
						<SelectItem key={option.value} value={option.value}>
							{option.label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</div>
	);
}

/**
 * Changing any condition recomputes every figure under the new conditions; nothing is
 * filtered on the client, so the numbers always match the evidence behind them.
 */
export function GeoInsightFilters({
	search,
	meta,
	onChange,
}: {
	search: InsightSearch;
	meta: MetricMeta | undefined;
	onChange: (next: Partial<InsightSearch>) => void;
}) {
	return (
		<div className="flex flex-wrap items-end gap-3">
			<Choice
				label="问法集版本"
				className="w-56"
				value={search.promptSetId ?? meta?.promptSet?.id}
				options={(meta?.promptSets ?? []).map((set) => ({
					value: set.id,
					label: `${set.name} v${set.version}（${set.observations} 条）`,
				}))}
				onChange={(promptSetId) => onChange({ promptSetId })}
			/>
			<div className="flex flex-col gap-1">
				<Label className="text-xs text-muted-foreground" htmlFor="geo-insight-from">
					开始日期
				</Label>
				<Input
					id="geo-insight-from"
					type="date"
					className="w-40"
					value={search.from ?? meta?.from ?? ""}
					onChange={(event) => onChange({ from: event.target.value || undefined })}
				/>
			</div>
			<div className="flex flex-col gap-1">
				<Label className="text-xs text-muted-foreground" htmlFor="geo-insight-to">
					结束日期
				</Label>
				<Input
					id="geo-insight-to"
					type="date"
					className="w-40"
					value={search.to ?? meta?.to ?? ""}
					onChange={(event) => onChange({ to: event.target.value || undefined })}
				/>
			</div>
			<Choice<GeoPlatform>
				label="平台"
				value={search.platform}
				allLabel="全部平台（分开统计）"
				className="w-48"
				options={GEO_PLATFORMS.map((platform) => ({ value: platform, label: GEO_PLATFORM_LABELS[platform] }))}
				onChange={(platform) => onChange({ platform })}
			/>
			<Choice<GeoSurfaceMode>
				label="采样方式"
				value={search.surfaceMode}
				allLabel="全部方式（分开统计）"
				className="w-48"
				options={GEO_SURFACE_MODES.map((mode) => ({ value: mode, label: GEO_SURFACE_MODE_LABELS[mode] }))}
				onChange={(surfaceMode) => onChange({ surfaceMode })}
			/>
		</div>
	);
}
