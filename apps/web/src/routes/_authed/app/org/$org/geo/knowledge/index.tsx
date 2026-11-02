import { createFileRoute, useRouteContext } from "@tanstack/react-router";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@workspace/ui/components/tabs";
import { AssetList } from "@/components/geo/knowledge/asset-list";
import { ClaimReviewQueue, ClaimSearch } from "@/components/geo/knowledge/claim-search";
import { ConflictList } from "@/components/geo/knowledge/conflicts";
import { DraftList } from "@/components/geo/knowledge/draft-list";
import { useKnowledgeOverview } from "@/components/geo/knowledge/queries";
import { GeoPageFrame } from "@/components/geo/shell/page-frame";
import { pageHead } from "@/lib/route-head";

const TABS = ["search", "review", "conflicts", "assets", "drafts"] as const;
type KnowledgeTab = (typeof TABS)[number];

interface KnowledgeSearch {
	tab?: KnowledgeTab;
}

export const Route = createFileRoute("/_authed/app/org/$org/geo/knowledge/")({
	staticData: { crumb: "可信知识" },
	head: pageHead({ description: "官网抽取事实、客户资料、资质、产品、案例、冲突与审批。" }),
	validateSearch: (search: Record<string, unknown>): KnowledgeSearch => ({
		tab:
			TABS.includes(search.tab as KnowledgeTab) && search.tab !== "search" ? (search.tab as KnowledgeTab) : undefined,
	}),
	component: GeoKnowledgePage,
});

function Count({ value }: { value: number | undefined }) {
	if (!value) return null;
	return <span className="ml-1 rounded-full bg-muted px-1.5 text-xs tabular-nums">{value}</span>;
}

function GeoKnowledgePage() {
	const { organization } = useRouteContext({ from: "/_authed/app/org/$org/geo" });
	const { tab } = Route.useSearch();
	const navigate = Route.useNavigate();
	const overview = useKnowledgeOverview(organization.id);
	const pending =
		(overview.data?.byStatus.PENDING_REVIEW ?? 0) +
		(overview.data?.byStatus.NEEDS_EVIDENCE ?? 0) +
		(overview.data?.byStatus.SOURCE_UNAVAILABLE ?? 0);

	return (
		<GeoPageFrame
			title="可信知识"
			description="官网抽取事实、客户资料、资质、产品、案例、冲突与审批。采集到的内容先进入待审核区，审核通过后才是可对外使用的事实。"
		>
			<Tabs
				value={tab ?? "search"}
				onValueChange={(value) =>
					navigate({ search: { tab: value === "search" ? undefined : (value as KnowledgeTab) }, replace: true })
				}
			>
				<TabsList>
					<TabsTrigger value="search">事实检索</TabsTrigger>
					<TabsTrigger value="review">
						待审核
						<Count value={pending} />
					</TabsTrigger>
					<TabsTrigger value="conflicts">
						冲突
						<Count value={overview.data?.openConflicts} />
					</TabsTrigger>
					<TabsTrigger value="assets">
						客户资料
						<Count value={overview.data?.pendingAssets} />
					</TabsTrigger>
					<TabsTrigger value="drafts">AI 草稿</TabsTrigger>
				</TabsList>
				<TabsContent value="search" className="mt-3">
					<ClaimSearch organizationId={organization.id} />
				</TabsContent>
				<TabsContent value="review" className="mt-3">
					<ClaimReviewQueue organizationId={organization.id} />
				</TabsContent>
				<TabsContent value="conflicts" className="mt-3">
					<ConflictList organizationId={organization.id} />
				</TabsContent>
				<TabsContent value="assets" className="mt-3">
					<AssetList organizationId={organization.id} />
				</TabsContent>
				<TabsContent value="drafts" className="mt-3">
					<DraftList organizationId={organization.id} />
				</TabsContent>
			</Tabs>
		</GeoPageFrame>
	);
}
