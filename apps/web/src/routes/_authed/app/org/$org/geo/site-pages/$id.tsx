import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { GEO_ASSERTION_STATUS_LABELS, type GeoAssertionStatus } from "@workspace/geo-domain";
import { Alert, AlertDescription } from "@workspace/ui/components/alert";
import { Button } from "@workspace/ui/components/button";
import { Card, CardContent, CardHeader } from "@workspace/ui/components/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@workspace/ui/components/select";
import { Skeleton } from "@workspace/ui/components/skeleton";
import { cn } from "@workspace/ui/lib/utils";
import { useState } from "react";
import { GeoEmptyState } from "@/components/geo/shell/empty-state";
import { GeoFactPendingBadge } from "@/components/geo/shell/evidence-badge";
import { GeoPageFrame } from "@/components/geo/shell/page-frame";
import { GeoAssertionStatusBadge, GeoStatusBadge } from "@/components/geo/shell/status-badge";
import { useGeoViewer } from "@/components/geo/shell/use-geo-viewer";
import { PageVersionView } from "@/components/geo/site-pages/page-version-view";
import {
	ENTITY_KIND_LABELS,
	errorMessage,
	formatDateTime,
	ParseStatusBadge,
	SitePageStatusBadge,
	siteQueryKeys,
} from "@/components/geo/site-pages/site-labels";
import { pageHead } from "@/lib/route-head";
import { getSitePageFn, refetchPageFn, requestReparseFn } from "@/server/geo/site";

export const Route = createFileRoute("/_authed/app/org/$org/geo/site-pages/$id")({
	staticData: { crumb: "页面详情" },
	head: pageHead({ description: "页面版本、原始快照与解析结果。" }),
	component: GeoSitePageDetailPage,
});

const CURRENT = "current";

type PageDetail = Awaited<ReturnType<typeof getSitePageFn>>;

function PageStatusLine({ page }: { page: PageDetail["page"] }) {
	return (
		<div className="flex flex-wrap items-center gap-2 text-sm">
			<SitePageStatusBadge status={page.status} />
			<GeoFactPendingBadge />
			<span className="text-muted-foreground">
				HTTP {page.httpStatus ?? "—"} · 最后发现 {formatDateTime(page.lastSeenAt)} · 最后抓取{" "}
				{formatDateTime(page.lastFetchedAt)}
				{page.consecutiveFailures > 0 ? ` · 连续失败 ${page.consecutiveFailures} 次` : ""}
			</span>
			{page.canonicalUrl && (
				<span className="text-muted-foreground">
					{page.status === "REDIRECTED" ? "跳转到" : "canonical"}：{page.canonicalUrl}
				</span>
			)}
		</div>
	);
}

function ReparseControls({
	profileItems,
	profileVersion,
	onProfileVersionChange,
	pending,
	onReparse,
}: {
	profileItems: Record<string, string>;
	profileVersion: string;
	onProfileVersionChange: (value: string) => void;
	pending: boolean;
	onReparse: () => void;
}) {
	return (
		<>
			<Select
				items={profileItems}
				value={profileVersion}
				onValueChange={(value) => onProfileVersionChange(String(value))}
			>
				<SelectTrigger className="w-40" size="sm">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{Object.entries(profileItems).map(([key, label]) => (
						<SelectItem key={key} value={key}>
							{label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			<Button size="sm" disabled={pending} onClick={onReparse}>
				重新解析所选版本
			</Button>
		</>
	);
}

function VersionList({
	versions,
	selectedId,
	onSelect,
}: {
	versions: PageDetail["versions"];
	selectedId: string | null;
	onSelect: (versionId: string) => void;
}) {
	return (
		<Card className="h-fit">
			<CardHeader className="pb-2 text-sm font-medium">内容版本（{versions.length}）</CardHeader>
			<CardContent className="flex flex-col gap-1 p-2">
				{versions.map((version) => (
					<button
						type="button"
						key={version.id}
						onClick={() => onSelect(version.id)}
						className={cn(
							"flex flex-col items-start gap-1 rounded-md px-2 py-2 text-left text-sm hover:bg-muted",
							version.id === selectedId && "bg-muted",
						)}
					>
						<span className="tabular-nums">{formatDateTime(version.fetchedAt)}</span>
						<span className="flex flex-wrap items-center gap-1">
							<ParseStatusBadge status={version.parseStatus} />
							<span className="font-mono text-xs text-muted-foreground">{version.parserVersion}</span>
						</span>
					</button>
				))}
			</CardContent>
		</Card>
	);
}

function CandidatesCard({
	org,
	entities,
	assertions,
}: {
	org: string;
	entities: PageDetail["entities"];
	assertions: PageDetail["assertions"];
}) {
	return (
		<Card>
			<CardHeader className="pb-2 text-sm font-medium">结构化候选与待审核事实</CardHeader>
			<CardContent className="flex flex-col gap-3 text-sm">
				<p className="text-muted-foreground">
					官网内容只是“来源已采集、事实待审核”。爬虫不会修改已批准的事实；新值会作为待审核候选与旧值并列，请逐条进入企业知识库审核。
				</p>
				{entities.length === 0 ? (
					<span className="text-muted-foreground">该页面没有映射出实体。</span>
				) : (
					<div className="flex flex-wrap gap-2">
						{entities.map((entity) => (
							<GeoStatusBadge
								key={entity.id}
								label={`${ENTITY_KIND_LABELS[entity.kind] ?? entity.kind}：${entity.title}`}
								tone={entity.status === "SOURCE_UNAVAILABLE" ? "danger" : "info"}
							/>
						))}
					</div>
				)}
				{assertions.map((assertion) => (
					<div
						key={`${assertion.id}-${assertion.pageVersionId}`}
						className="flex flex-wrap items-start gap-2 rounded-md border p-2"
					>
						<GeoAssertionStatusBadge status={assertion.status as GeoAssertionStatus} />
						{assertion.riskLevel === "HIGH" && <GeoStatusBadge label="高风险，需原件核对" tone="danger" />}
						<span className="min-w-0 flex-1 break-all">{assertion.claimText ?? "保密内容（无权查看）"}</span>
						<span className="text-xs text-muted-foreground">
							{GEO_ASSERTION_STATUS_LABELS[assertion.status as GeoAssertionStatus]} · {assertion.fieldPath}
						</span>
						<Link
							to="/app/org/$org/geo/knowledge/$id"
							params={{ org, id: assertion.id }}
							className="text-xs whitespace-nowrap underline"
						>
							在知识库中审核
						</Link>
					</div>
				))}
			</CardContent>
		</Card>
	);
}

function profileItemsOf(profileVersions: PageDetail["profileVersions"]): Record<string, string> {
	return {
		[CURRENT]: "当前解析配置",
		...Object.fromEntries(profileVersions.map((entry) => [String(entry.version), `解析配置 v${entry.version}`])),
	};
}

function reparseNotice(jobId: string | null): string {
	return jobId ? `已提交重新解析任务（${jobId}），完成后会新增解析版本。` : "相同的重新解析任务已在排队。";
}

function GeoSitePageDetailPage() {
	const viewer = useGeoViewer();
	const { org, id } = Route.useParams();
	const organizationId = viewer.organizationId;
	const queryClient = useQueryClient();
	const [selectedVersion, setSelectedVersion] = useState<string | null>(null);
	const [profileVersion, setProfileVersion] = useState(CURRENT);
	const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

	const detail = useQuery({
		queryKey: siteQueryKeys.page(organizationId, id),
		queryFn: () => getSitePageFn({ data: { organizationId, pageId: id } }),
		refetchInterval: 15_000,
	});
	const versionId = selectedVersion ?? detail.data?.versions[0]?.id ?? null;
	const onError = (error: unknown) => setNotice({ tone: "error", text: errorMessage(error) });
	const reparse = useMutation({
		mutationFn: () =>
			requestReparseFn({
				data: {
					organizationId,
					pageId: id,
					input: { versionId, profileVersion: profileVersion === CURRENT ? null : Number(profileVersion) },
				},
			}),
		onSuccess: (result) => {
			setNotice({ tone: "ok", text: reparseNotice(result.jobId) });
			queryClient.invalidateQueries({ queryKey: siteQueryKeys.page(organizationId, id) });
		},
		onError,
	});
	const refetch = useMutation({
		mutationFn: () => refetchPageFn({ data: { organizationId, pageId: id } }),
		onSuccess: (result) =>
			setNotice({
				tone: "ok",
				text: result.created ? "已创建单页采集任务。" : "该站点已有进行中的采集任务，本页会在其中处理。",
			}),
		onError,
	});

	if (detail.isLoading) {
		return (
			<GeoPageFrame title="页面详情" description="页面版本、原始快照与解析结果。">
				<Skeleton className="h-96 w-full" />
			</GeoPageFrame>
		);
	}
	if (!detail.data) {
		return (
			<GeoPageFrame title="页面详情" description="页面版本、原始快照与解析结果。">
				<GeoEmptyState title="页面不存在" description={detail.error?.message} />
			</GeoPageFrame>
		);
	}
	const { page, versions, entities, assertions, profileVersions } = detail.data;

	return (
		<GeoPageFrame
			title={versions[0]?.title ?? "页面详情"}
			description={page.url}
			actions={
				<>
					{viewer.can("site.crawl") && (
						<Button size="sm" variant="outline" disabled={refetch.isPending} onClick={() => refetch.mutate()}>
							重新抓取
						</Button>
					)}
					{viewer.can("site.reparse") && versions.length > 0 && (
						<ReparseControls
							profileItems={profileItemsOf(profileVersions)}
							profileVersion={profileVersion}
							onProfileVersionChange={setProfileVersion}
							pending={reparse.isPending}
							onReparse={() => reparse.mutate()}
						/>
					)}
				</>
			}
		>
			<PageStatusLine page={page} />
			{notice && (
				<Alert variant={notice.tone === "error" ? "destructive" : "default"}>
					<AlertDescription>{notice.text}</AlertDescription>
				</Alert>
			)}
			{versions.length === 0 ? (
				<GeoEmptyState title="还没有内容版本" description="页面已发现但尚未成功抓取或解析。" />
			) : (
				<div className="grid gap-4 lg:grid-cols-[18rem_1fr]">
					<VersionList versions={versions} selectedId={versionId} onSelect={setSelectedVersion} />
					<div className="flex min-w-0 flex-col gap-4">
						{versionId && (
							<PageVersionView key={versionId} organizationId={organizationId} pageId={id} versionId={versionId} />
						)}
						<CandidatesCard org={org} entities={entities} assertions={assertions} />
					</div>
				</div>
			)}
		</GeoPageFrame>
	);
}
