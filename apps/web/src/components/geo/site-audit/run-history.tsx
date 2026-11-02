import { useQuery } from "@tanstack/react-query";
import { Alert, AlertDescription } from "@workspace/ui/components/alert";
import { Skeleton } from "@workspace/ui/components/skeleton";
import { useState } from "react";
import { GeoEmptyState } from "@/components/geo/shell/empty-state";
import { GeoPaginatedTable } from "@/components/geo/shell/paginated-table";
import { errorMessage, formatDateTime } from "@/components/geo/site-pages/site-labels";
import { listSiteAuditRunsFn } from "@/server/geo/site-audit";
import { AuditRunStatusBadge, requesterLabel, siteAuditKeys } from "./labels";

type RunRow = Awaited<ReturnType<typeof listSiteAuditRunsFn>>["rows"][number];

export function RunHistory({ organizationId, siteSourceId }: { organizationId: string; siteSourceId: string }) {
	const [page, setPage] = useState(1);
	const runs = useQuery({
		queryKey: siteAuditKeys.runs(organizationId, siteSourceId, page),
		queryFn: () => listSiteAuditRunsFn({ data: { organizationId, siteSourceId, page, limit: 20 } }),
		refetchInterval: (query) =>
			query.state.data?.rows.some((run) => run.status === "QUEUED" || run.status === "RUNNING") ? 5000 : false,
	});
	if (runs.isLoading) return <Skeleton className="h-48 w-full" />;
	if (runs.error) {
		return (
			<Alert variant="destructive">
				<AlertDescription>{errorMessage(runs.error)}</AlertDescription>
			</Alert>
		);
	}
	const total = runs.data?.total ?? 0;
	return (
		<GeoPaginatedTable<RunRow>
			rows={runs.data?.rows ?? []}
			rowKey={(run) => run.id}
			page={page}
			total={total}
			totalPages={Math.max(1, Math.ceil(total / 20))}
			onPageChange={setPage}
			empty={<GeoEmptyState title="还没有审计记录" description="官网采集成功后会自动审计，也可以手动运行。" />}
			columns={[
				{ key: "created", header: "发起时间", cell: (run) => formatDateTime(run.createdAt) },
				{ key: "status", header: "状态", cell: (run) => <AuditRunStatusBadge status={run.status} /> },
				{
					key: "trigger",
					header: "来源",
					cell: (run) => (
						<span className="text-sm">
							{requesterLabel(run.requestedBy)}
							{run.siteChecks ? "" : "（未做站点级检查）"}
						</span>
					),
				},
				{ key: "pages", header: "审计页面", cell: (run) => run.counts.pages ?? "—" },
				{ key: "new", header: "新发现", cell: (run) => run.counts.inserted ?? "—" },
				{ key: "resolved", header: "自动解决", cell: (run) => run.counts.resolved ?? "—" },
				{ key: "reopened", header: "再次出现", cell: (run) => run.counts.reopened ?? "—" },
				{
					key: "note",
					header: "说明",
					cell: (run) => (
						<span className="text-sm text-muted-foreground">
							{run.errorSummary ??
								((run.counts.pendingParse ?? 0) > 0
									? `${run.counts.pendingParse} 个新版本尚未解析，未纳入本次审计`
									: "")}
						</span>
					),
				},
				{ key: "rules", header: "规则版本", cell: (run) => <span className="text-xs">{run.ruleVersion}</span> },
			]}
		/>
	);
}
