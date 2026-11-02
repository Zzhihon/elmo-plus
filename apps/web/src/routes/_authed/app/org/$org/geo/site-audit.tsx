import { IconInfoCircle, IconPlayerPlay } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
	SITE_AUDIT_RULE_GROUP_LABELS,
	SITE_AUDIT_RULE_GROUPS,
	SITE_AUDIT_SCOPE_NOTICE,
} from "@workspace/geo-site-ingestion/audit/catalog";
import { Alert, AlertDescription, AlertTitle } from "@workspace/ui/components/alert";
import { Button } from "@workspace/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@workspace/ui/components/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@workspace/ui/components/select";
import { Skeleton } from "@workspace/ui/components/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@workspace/ui/components/tabs";
import { useState } from "react";
import { GeoEmptyState } from "@/components/geo/shell/empty-state";
import { GeoPageFrame } from "@/components/geo/shell/page-frame";
import { useGeoViewer } from "@/components/geo/shell/use-geo-viewer";
import { FindingGroups } from "@/components/geo/site-audit/finding-groups";
import { AuditRunStatusBadge, requesterLabel, siteAuditKeys } from "@/components/geo/site-audit/labels";
import { RunHistory } from "@/components/geo/site-audit/run-history";
import { SiteChecksPanel } from "@/components/geo/site-audit/site-checks-panel";
import { errorMessage, formatDateTime } from "@/components/geo/site-pages/site-labels";
import { pageHead } from "@/lib/route-head";
import { getSiteAuditOverviewFn, listAuditSourcesFn, startSiteAuditFn } from "@/server/geo/site-audit";

export const Route = createFileRoute("/_authed/app/org/$org/geo/site-audit")({
	staticData: { crumb: "站点审计" },
	head: pageHead({ description: "可抓取性、元数据缺口、失效页面与内容建议。" }),
	component: GeoSiteAuditPage,
});

type Overview = Awaited<ReturnType<typeof getSiteAuditOverviewFn>>;

function Stat({ label, value, hint }: { label: string; value: number; hint?: string }) {
	return (
		<div className="flex flex-col gap-1 rounded-md border px-4 py-3">
			<span className="text-xs text-muted-foreground">{label}</span>
			<span className="text-2xl font-semibold tabular-nums">{value}</span>
			{hint && <span className="text-xs text-muted-foreground">{hint}</span>}
		</div>
	);
}

function Summary({ overview }: { overview: Overview }) {
	const open = overview.byStatus.OPEN ?? 0;
	const tasked = overview.byStatus.TASKED ?? 0;
	const run = overview.latestRun;
	return (
		<Card>
			<CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
				<CardTitle className="text-base">审计概况</CardTitle>
				{run ? (
					<div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
						<AuditRunStatusBadge status={run.status} />
						<span>
							最近一次：{formatDateTime(run.finishedAt ?? run.createdAt)}，{requesterLabel(run.requestedBy)}
						</span>
					</div>
				) : (
					<span className="text-sm text-muted-foreground">还没有运行过审计</span>
				)}
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				{run?.status === "FAILED" && run.errorSummary && (
					<Alert variant="destructive">
						<AlertDescription>最近一次审计失败：{run.errorSummary}</AlertDescription>
					</Alert>
				)}
				<div className="grid grid-cols-2 gap-3 md:grid-cols-5">
					<Stat label="待处理" value={open} />
					<Stat label="已建工单" value={tasked} />
					<Stat label="高严重度（未关闭）" value={overview.openBySeverity.HIGH ?? 0} />
					<Stat label="已解决" value={overview.byStatus.RESOLVED ?? 0} hint="复跑审计时自动判定" />
					<Stat label="已忽略" value={overview.byStatus.DISMISSED ?? 0} />
				</div>
				<div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted-foreground">
					{SITE_AUDIT_RULE_GROUPS.map((group) => (
						<span key={group}>
							{SITE_AUDIT_RULE_GROUP_LABELS[group]} {overview.openByGroup[group] ?? 0}
						</span>
					))}
				</div>
			</CardContent>
		</Card>
	);
}

function RunAuditButton({
	organizationId,
	siteSourceId,
	busy,
}: {
	organizationId: string;
	siteSourceId: string;
	busy: boolean;
}) {
	const viewer = useGeoViewer();
	const queryClient = useQueryClient();
	const start = useMutation({
		mutationFn: () => startSiteAuditFn({ data: { organizationId, input: { siteSourceId } } }),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: siteAuditKeys.all(organizationId) }),
	});
	if (!viewer.can("site_audit.run")) return null;
	return (
		<div className="flex flex-col items-end gap-1">
			<Button size="sm" onClick={() => start.mutate()} disabled={busy || start.isPending}>
				<IconPlayerPlay />
				{busy ? "审计进行中" : "运行审计"}
			</Button>
			{start.error && <span className="text-xs text-destructive">{errorMessage(start.error)}</span>}
		</div>
	);
}

type Source = Awaited<ReturnType<typeof listAuditSourcesFn>>[number];

function SourceSelect({
	sources,
	value,
	onChange,
}: {
	sources: Source[];
	value: string;
	onChange: (id: string) => void;
}) {
	return (
		<Select
			items={Object.fromEntries(sources.map((entry) => [entry.id, entry.baseUrl]))}
			value={value}
			onValueChange={(next) => onChange(String(next))}
		>
			<SelectTrigger className="w-80">
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				{sources.map((entry) => (
					<SelectItem key={entry.id} value={entry.id}>
						{entry.baseUrl}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

function useOverview(organizationId: string, siteSourceId: string | null) {
	return useQuery({
		queryKey: siteAuditKeys.overview(organizationId, siteSourceId ?? ""),
		queryFn: () => getSiteAuditOverviewFn({ data: { organizationId, siteSourceId: siteSourceId as string } }),
		enabled: Boolean(siteSourceId),
		refetchInterval: (query) => {
			const status = query.state.data?.latestRun?.status;
			return status === "QUEUED" || status === "RUNNING" ? 5000 : false;
		},
	});
}

function AuditContent({
	organizationId,
	orgSlug,
	siteSourceId,
	overview,
}: {
	organizationId: string;
	orgSlug: string;
	siteSourceId: string;
	overview: ReturnType<typeof useOverview>;
}) {
	const [tab, setTab] = useState("findings");
	if (overview.error) {
		return (
			<Alert variant="destructive">
				<AlertDescription>{errorMessage(overview.error)}</AlertDescription>
			</Alert>
		);
	}
	if (!overview.data) return <Skeleton className="h-64 w-full" />;
	return (
		<>
			<Summary overview={overview.data} />
			<SiteChecksPanel siteChecks={overview.data.siteChecks} />
			<Tabs value={tab} onValueChange={(value) => setTab(String(value))}>
				<TabsList>
					<TabsTrigger value="findings">发现（按页面）</TabsTrigger>
					<TabsTrigger value="runs">审计记录</TabsTrigger>
				</TabsList>
				<TabsContent value="findings" className="pt-4">
					<FindingGroups
						key={siteSourceId}
						organizationId={organizationId}
						orgSlug={orgSlug}
						siteSourceId={siteSourceId}
					/>
				</TabsContent>
				<TabsContent value="runs" className="pt-4">
					<RunHistory organizationId={organizationId} siteSourceId={siteSourceId} />
				</TabsContent>
			</Tabs>
		</>
	);
}

function GeoSiteAuditPage() {
	const viewer = useGeoViewer();
	const { org } = Route.useParams();
	const organizationId = viewer.organizationId;
	const [siteId, setSiteId] = useState<string | null>(null);
	const sources = useQuery({
		queryKey: siteAuditKeys.sources(organizationId),
		queryFn: () => listAuditSourcesFn({ data: { organizationId } }),
	});
	const list = sources.data ?? [];
	const source = list.find((entry) => entry.id === siteId) ?? list[0] ?? null;
	const overview = useOverview(organizationId, source?.id ?? null);
	const status = overview.data?.latestRun?.status;

	return (
		<GeoPageFrame
			title="站点审计"
			description="基于已采集的页面快照诊断可抓取性、元数据、失效链接、结构化数据与内容完整度，并生成整改建议。"
			actions={
				source ? (
					<RunAuditButton
						organizationId={organizationId}
						siteSourceId={source.id}
						busy={status === "QUEUED" || status === "RUNNING"}
					/>
				) : undefined
			}
			filters={
				list.length > 1 && source ? <SourceSelect sources={list} value={source.id} onChange={setSiteId} /> : undefined
			}
		>
			<Alert>
				<IconInfoCircle />
				<AlertTitle>审计范围说明</AlertTitle>
				<AlertDescription>{SITE_AUDIT_SCOPE_NOTICE}</AlertDescription>
			</Alert>
			{sources.isLoading ? (
				<Skeleton className="h-64 w-full" />
			) : source ? (
				<AuditContent organizationId={organizationId} orgSlug={org} siteSourceId={source.id} overview={overview} />
			) : (
				<GeoEmptyState
					title="还没有授权站点"
					description="先在官网来源页登记站点并完成首次采集，采集成功后会自动运行审计。"
					action={
						<Link to="/app/org/$org/geo/sources" params={{ org }} className="text-sm underline">
							前往官网来源
						</Link>
					}
				/>
			)}
		</GeoPageFrame>
	);
}
