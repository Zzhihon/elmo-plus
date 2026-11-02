import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Checkbox } from "@workspace/ui/components/checkbox";
import { Input } from "@workspace/ui/components/input";
import { Label } from "@workspace/ui/components/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@workspace/ui/components/select";
import { Skeleton } from "@workspace/ui/components/skeleton";
import { useState } from "react";
import { GeoEmptyState } from "@/components/geo/shell/empty-state";
import { GeoPaginatedTable } from "@/components/geo/shell/paginated-table";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { listSitePagesFn } from "@/server/geo/site";
import type { SitePageFilters, SitePageRow, SiteSourceView } from "@/server/geo/site-core";
import {
	formatDateTime,
	PAGE_STATUS_LABELS,
	PARSE_STATUS_LABELS,
	ParseStatusBadge,
	SitePageStatusBadge,
	siteQueryKeys,
} from "./site-labels";

const ALL = "__all";
const PAGE_SIZE = 25;

function FilterSelect({
	id,
	label,
	value,
	onChange,
	options,
}: {
	id: string;
	label: string;
	value: string;
	onChange: (value: string) => void;
	options: Record<string, string>;
}) {
	const items = { [ALL]: "全部", ...options };
	return (
		<div className="grid gap-1">
			<Label htmlFor={id} className="text-xs text-muted-foreground">
				{label}
			</Label>
			<Select items={items} value={value} onValueChange={(next) => onChange(String(next ?? ALL))}>
				<SelectTrigger id={id} className="w-40">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{Object.entries(items).map(([key, text]) => (
						<SelectItem key={key} value={key}>
							{text}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</div>
	);
}

export function SitePageTable({
	organizationId,
	orgSlug,
	source,
}: {
	organizationId: string;
	orgSlug: string;
	source: SiteSourceView;
}) {
	const [page, setPage] = useState(1);
	const [category, setCategory] = useState(ALL);
	const [status, setStatus] = useState(ALL);
	const [parseStatus, setParseStatus] = useState(ALL);
	const [reviewStatus, setReviewStatus] = useState(ALL);
	const [hasError, setHasError] = useState(false);
	const [search, setSearch] = useState("");
	const q = useDebouncedValue(search, 300);

	const filters: SitePageFilters = {
		siteId: source.id,
		category: category === ALL ? undefined : category,
		status: status === ALL ? undefined : (status as SitePageFilters["status"]),
		parseStatus: parseStatus === ALL ? undefined : (parseStatus as SitePageFilters["parseStatus"]),
		reviewStatus: reviewStatus === ALL ? undefined : (reviewStatus as SitePageFilters["reviewStatus"]),
		hasError: hasError || undefined,
		q: q.trim() || undefined,
	};
	const pages = useQuery({
		queryKey: siteQueryKeys.pages(organizationId, filters, page),
		queryFn: () => listSitePagesFn({ data: { organizationId, filters, page, limit: PAGE_SIZE } }),
		placeholderData: keepPreviousData,
	});
	const reset =
		<T,>(setter: (value: T) => void) =>
		(value: T) => {
			setter(value);
			setPage(1);
		};

	const categories: Record<string, string> = Object.fromEntries(
		source.categories.map((entry) => [entry.key, entry.label]),
	);
	categories.attachment = "附件";
	categories.uncategorized = "未分类";

	return (
		<div className="flex flex-col gap-3">
			<div className="flex flex-wrap items-end gap-3">
				<div className="grid gap-1">
					<Label htmlFor="site-page-search" className="text-xs text-muted-foreground">
						网址
					</Label>
					<Input
						id="site-page-search"
						className="w-64"
						placeholder="按网址片段搜索"
						value={search}
						onChange={(event) => reset(setSearch)(event.target.value)}
					/>
				</div>
				<FilterSelect
					id="site-page-category"
					label="栏目"
					value={category}
					onChange={reset(setCategory)}
					options={categories}
				/>
				<FilterSelect
					id="site-page-status"
					label="页面状态"
					value={status}
					onChange={reset(setStatus)}
					options={PAGE_STATUS_LABELS}
				/>
				<FilterSelect
					id="site-page-parse"
					label="解析状态"
					value={parseStatus}
					onChange={reset(setParseStatus)}
					options={PARSE_STATUS_LABELS}
				/>
				<FilterSelect
					id="site-page-review"
					label="审核状态"
					value={reviewStatus}
					onChange={reset(setReviewStatus)}
					options={{ PENDING_REVIEW: "有待审核事实", APPROVED: "有已批准事实", NONE: "无事实候选" }}
				/>
				<div className="flex items-center gap-2 pb-2">
					<Checkbox
						id="site-page-errors"
						checked={hasError}
						onCheckedChange={(checked) => reset(setHasError)(Boolean(checked))}
					/>
					<Label htmlFor="site-page-errors">只看异常</Label>
				</div>
			</div>
			{pages.isLoading ? (
				<Skeleton className="h-64 w-full" />
			) : (
				<GeoPaginatedTable<SitePageRow>
					rows={pages.data?.rows ?? []}
					total={pages.data?.total ?? 0}
					page={page}
					totalPages={Math.ceil((pages.data?.total ?? 0) / PAGE_SIZE)}
					onPageChange={setPage}
					rowKey={(row) => row.id}
					empty={<GeoEmptyState title="没有符合条件的页面" description="调整筛选条件，或先在官网来源页启动采集。" />}
					columns={[
						{
							key: "url",
							header: "页面",
							className: "max-w-md",
							cell: (row) => (
								<div className="flex min-w-0 flex-col">
									<Link
										to="/app/org/$org/geo/site-pages/$id"
										params={{ org: orgSlug, id: row.id }}
										className="truncate font-medium underline-offset-4 hover:underline"
									>
										{row.title ?? row.url}
									</Link>
									<span className="truncate text-xs text-muted-foreground">{row.url}</span>
								</div>
							),
						},
						{
							key: "category",
							header: "栏目",
							cell: (row) => (row.category ? (categories[row.category] ?? row.category) : "未分类"),
						},
						{ key: "status", header: "页面状态", cell: (row) => <SitePageStatusBadge status={row.status} /> },
						{ key: "http", header: "HTTP", className: "tabular-nums", cell: (row) => row.httpStatus ?? "—" },
						{ key: "parse", header: "解析", cell: (row) => <ParseStatusBadge status={row.parseStatus} /> },
						{ key: "versions", header: "版本", className: "tabular-nums", cell: (row) => row.versionCount },
						{ key: "seen", header: "最后发现", cell: (row) => formatDateTime(row.lastSeenAt) },
					]}
				/>
			)}
		</div>
	);
}
