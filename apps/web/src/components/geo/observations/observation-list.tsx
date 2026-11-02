import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
	GEO_OBSERVATION_STATUSES,
	GEO_PLATFORM_LABELS,
	GEO_PLATFORMS,
	GEO_RECOMMENDATION_LABELS,
	GEO_RUN_STATUS_LABELS,
	GEO_SURFACE_MODE_LABELS,
	GEO_SURFACE_MODES,
	type GeoRecommendation,
} from "@workspace/geo-domain";
import { Input } from "@workspace/ui/components/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@workspace/ui/components/select";
import { Skeleton } from "@workspace/ui/components/skeleton";
import { useEffect, useState } from "react";
import { formatDateTime } from "@/components/geo/sampling/format";
import { observationKeys } from "@/components/geo/sampling/keys";
import { useGeoOrganization } from "@/components/geo/sampling/use-geo-organization";
import { GeoPlatformBadge, GeoSurfaceModeBadge } from "@/components/geo/shell/evidence-badge";
import { GeoPaginatedTable, type GeoTableColumn } from "@/components/geo/shell/paginated-table";
import { GeoRunStatusBadge, GeoStatusBadge } from "@/components/geo/shell/status-badge";
import { listObservationsFn } from "@/server/geo/observations";
import type { ObservationListItem } from "@/server/geo/observations-core";
import type { ObservationSearch } from "./search";

const ALL = "ALL";

function FilterSelect<T extends string>({
	label,
	value,
	options,
	labels,
	onChange,
}: {
	label: string;
	value: T | undefined;
	options: readonly T[];
	labels: Record<T, string>;
	onChange: (value: T | undefined) => void;
}) {
	return (
		<Select
			items={{ [ALL]: `全部${label}`, ...labels }}
			value={value ?? ALL}
			onValueChange={(next) => onChange(next === ALL ? undefined : (next as T))}
		>
			<SelectTrigger className="w-36" aria-label={label}>
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				<SelectItem value={ALL}>全部{label}</SelectItem>
				{options.map((option) => (
					<SelectItem key={option} value={option}>
						{labels[option]}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

export function ObservationFilters({
	search,
	onChange,
}: {
	search: ObservationSearch;
	onChange: (next: Partial<ObservationSearch>) => void;
}) {
	const [q, setQ] = useState(search.q ?? "");
	useEffect(() => setQ(search.q ?? ""), [search.q]);
	return (
		<div className="flex flex-wrap items-center gap-2">
			<Input
				className="w-64"
				placeholder="按问题搜索"
				value={q}
				onChange={(e) => setQ(e.target.value)}
				onBlur={() => onChange({ q: q.trim() || undefined })}
				onKeyDown={(e) => {
					if (e.key === "Enter") onChange({ q: q.trim() || undefined });
				}}
				aria-label="按问题搜索"
			/>
			<FilterSelect
				label="平台"
				value={search.platform}
				options={GEO_PLATFORMS}
				labels={GEO_PLATFORM_LABELS}
				onChange={(platform) => onChange({ platform })}
			/>
			<FilterSelect
				label="源模式"
				value={search.surfaceMode}
				options={GEO_SURFACE_MODES}
				labels={GEO_SURFACE_MODE_LABELS}
				onChange={(surfaceMode) => onChange({ surfaceMode })}
			/>
			<FilterSelect
				label="状态"
				value={search.status}
				options={GEO_OBSERVATION_STATUSES}
				labels={GEO_RUN_STATUS_LABELS}
				onChange={(status) => onChange({ status })}
			/>
			<Input
				type="date"
				className="w-40"
				aria-label="开始日期"
				value={search.from ?? ""}
				onChange={(e) => onChange({ from: e.target.value || undefined })}
			/>
			<span className="text-sm text-muted-foreground">至</span>
			<Input
				type="date"
				className="w-40"
				aria-label="结束日期"
				value={search.to ?? ""}
				onChange={(e) => onChange({ to: e.target.value || undefined })}
			/>
		</div>
	);
}

function EvaluationCell({ row }: { row: ObservationListItem }) {
	if (!row.countsInRates) return <GeoStatusBadge label="不计入比率" />;
	if (!row.evaluation) return <span className="text-xs text-muted-foreground">待评估</span>;
	return (
		<span className="text-sm">
			{GEO_RECOMMENDATION_LABELS[row.evaluation.recommendation as GeoRecommendation] ?? row.evaluation.recommendation}
		</span>
	);
}

export function ObservationList({
	search,
	onPageChange,
}: {
	search: ObservationSearch;
	onPageChange: (page: number) => void;
}) {
	const organization = useGeoOrganization();
	const { page = 1, ...filters } = search;
	const list = useQuery({
		queryKey: observationKeys.list(organization.id, filters, page),
		queryFn: () => listObservationsFn({ data: { organizationId: organization.id, page, limit: 20, filters } }),
		placeholderData: keepPreviousData,
	});

	const columns: GeoTableColumn<ObservationListItem>[] = [
		{ key: "time", header: "采样时间", cell: (row) => formatDateTime(row.sampledAt), className: "whitespace-nowrap" },
		{
			key: "question",
			header: "问题",
			cell: (row) => (
				<Link
					to="/app/org/$org/geo/observations/$id"
					params={{ org: organization.slug, id: row.id }}
					className="line-clamp-2 max-w-96 hover:underline"
				>
					{row.questionText}
				</Link>
			),
		},
		{ key: "platform", header: "平台", cell: (row) => <GeoPlatformBadge platform={row.platform} /> },
		{ key: "mode", header: "源模式", cell: (row) => <GeoSurfaceModeBadge mode={row.surfaceMode} /> },
		{
			key: "status",
			header: "状态",
			cell: (row) => (
				<div className="flex flex-col gap-1">
					<GeoRunStatusBadge status={row.status} />
					{row.errorCode && <span className="text-xs text-muted-foreground">{row.errorCode}</span>}
				</div>
			),
		},
		{ key: "evaluation", header: "评估结论", cell: (row) => <EvaluationCell row={row} /> },
		{ key: "citations", header: "引用", cell: (row) => row.citationCount, className: "tabular-nums" },
		{
			key: "origin",
			header: "来源",
			cell: (row) => (
				<span className="text-xs text-muted-foreground">
					{row.imported ? "人工导入" : row.retryOfObservationId ? "重采" : "自动采样"}
				</span>
			),
		},
	];

	if (!list.data) return <Skeleton className="h-64 w-full" />;
	return (
		<GeoPaginatedTable
			columns={columns}
			rows={list.data.rows}
			rowKey={(row) => row.id}
			page={list.data.page}
			totalPages={list.data.totalPages}
			total={list.data.total}
			onPageChange={onPageChange}
		/>
	);
}
