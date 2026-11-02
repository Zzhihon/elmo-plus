import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@workspace/ui/components/select";
import { Skeleton } from "@workspace/ui/components/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@workspace/ui/components/tabs";
import { useState } from "react";
import { GeoEmptyState } from "@/components/geo/shell/empty-state";
import { GeoPageFrame } from "@/components/geo/shell/page-frame";
import { useGeoViewer } from "@/components/geo/shell/use-geo-viewer";
import { KeyUrlCoverage } from "@/components/geo/site-pages/key-url-coverage";
import { QualitySample } from "@/components/geo/site-pages/quality-sample";
import { siteQueryKeys } from "@/components/geo/site-pages/site-labels";
import { SitePageTable } from "@/components/geo/site-pages/site-page-table";
import { pageHead } from "@/lib/route-head";
import { listSitesFn } from "@/server/geo/site";

export const Route = createFileRoute("/_authed/app/org/$org/geo/site-pages/")({
	staticData: { crumb: "官网页面" },
	head: pageHead({ description: "页面列表、来源快照、解析状态、内容版本和差异。" }),
	component: GeoSitePagesPage,
});

function GeoSitePagesPage() {
	const viewer = useGeoViewer();
	const { org } = Route.useParams();
	const organizationId = viewer.organizationId;
	const [siteId, setSiteId] = useState<string | null>(null);
	const [tab, setTab] = useState("pages");
	const sites = useQuery({
		queryKey: siteQueryKeys.sites(organizationId),
		queryFn: () => listSitesFn({ data: { organizationId } }),
	});
	const source = sites.data?.find((entry) => entry.id === siteId) ?? sites.data?.[0] ?? null;

	return (
		<GeoPageFrame
			title="官网页面"
			description="页面列表、来源快照、解析状态、内容版本和差异。所有内容均为“来源已采集、事实待审核”。"
			filters={
				(sites.data?.length ?? 0) > 1 && source ? (
					<Select
						items={Object.fromEntries((sites.data ?? []).map((entry) => [entry.id, entry.baseUrl]))}
						value={source.id}
						onValueChange={(value) => setSiteId(String(value))}
					>
						<SelectTrigger className="w-80">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{(sites.data ?? []).map((entry) => (
								<SelectItem key={entry.id} value={entry.id}>
									{entry.baseUrl}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				) : undefined
			}
		>
			{sites.isLoading ? (
				<Skeleton className="h-64 w-full" />
			) : !source ? (
				<GeoEmptyState
					title="还没有授权站点"
					description="先在官网来源页登记站点并完成首次采集。"
					action={
						<Link to="/app/org/$org/geo/sources" params={{ org }} className="text-sm underline">
							前往官网来源
						</Link>
					}
				/>
			) : (
				<Tabs value={tab} onValueChange={(value) => setTab(String(value))}>
					<TabsList>
						<TabsTrigger value="pages">页面列表</TabsTrigger>
						<TabsTrigger value="coverage">重点网址覆盖</TabsTrigger>
						<TabsTrigger value="quality">抽样质检</TabsTrigger>
					</TabsList>
					<TabsContent value="pages" className="pt-4">
						<SitePageTable organizationId={organizationId} orgSlug={org} source={source} />
					</TabsContent>
					<TabsContent value="coverage" className="pt-4">
						<KeyUrlCoverage key={source.id} organizationId={organizationId} orgSlug={org} source={source} />
					</TabsContent>
					<TabsContent value="quality" className="pt-4">
						<QualitySample organizationId={organizationId} orgSlug={org} source={source} />
					</TabsContent>
				</Tabs>
			)}
		</GeoPageFrame>
	);
}
