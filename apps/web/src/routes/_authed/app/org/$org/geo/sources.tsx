import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@workspace/ui/components/button";
import { Skeleton } from "@workspace/ui/components/skeleton";
import { useState } from "react";
import { GeoEmptyState } from "@/components/geo/shell/empty-state";
import { GeoPageFrame } from "@/components/geo/shell/page-frame";
import { useGeoViewer } from "@/components/geo/shell/use-geo-viewer";
import { siteQueryKeys } from "@/components/geo/site-pages/site-labels";
import { SiteSourceCard } from "@/components/geo/sources/site-source-card";
import { SiteSourceDialog } from "@/components/geo/sources/site-source-dialog";
import { pageHead } from "@/lib/route-head";
import { listSitesFn } from "@/server/geo/site";

export const Route = createFileRoute("/_authed/app/org/$org/geo/sources")({
	staticData: { crumb: "官网来源" },
	head: pageHead({ description: "授权官网、域名白名单、栏目、采集策略与上次同步。" }),
	component: GeoSourcesPage,
});

function GeoSourcesPage() {
	const viewer = useGeoViewer();
	const { org } = Route.useParams();
	const organizationId = viewer.organizationId;
	const [creating, setCreating] = useState(false);
	const sites = useQuery({
		queryKey: siteQueryKeys.sites(organizationId),
		queryFn: () => listSitesFn({ data: { organizationId } }),
	});

	return (
		<GeoPageFrame
			title="官网来源"
			description="授权官网、域名白名单、栏目、采集策略与上次同步。采集到的内容只是“来源已采集、事实待审核”。"
			actions={
				viewer.can("site.manage") && (
					<Button size="sm" onClick={() => setCreating(true)}>
						登记站点
					</Button>
				)
			}
		>
			{sites.isLoading ? (
				<Skeleton className="h-64 w-full" />
			) : sites.error ? (
				<GeoEmptyState title="加载失败" description={sites.error.message} />
			) : (sites.data ?? []).length === 0 ? (
				<GeoEmptyState
					title="还没有登记授权站点"
					description="登记客户已授权采集的官网后，系统会按限速规则抓取公开页面并保留原始快照。"
				/>
			) : (
				<div className="flex flex-col gap-4">
					{(sites.data ?? []).map((source) => (
						<SiteSourceCard key={source.id} organizationId={organizationId} orgSlug={org} source={source} />
					))}
				</div>
			)}
			{creating && (
				<SiteSourceDialog organizationId={organizationId} source={null} open={creating} onOpenChange={setCreating} />
			)}
		</GeoPageFrame>
	);
}
