import { IconRefresh } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import type { GeoCitedContentType, GeoRecommendationKind } from "@workspace/geo-domain";
import {
	GEO_CITED_CONTENT_TYPE_LABELS,
	GEO_ON_SITE_CONTENT_TYPES,
	GEO_RECOMMENDATION_KIND_LABELS,
} from "@workspace/geo-reports/recommendations/labels";
import { Button } from "@workspace/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@workspace/ui/components/card";
import { Label } from "@workspace/ui/components/label";
import { Skeleton } from "@workspace/ui/components/skeleton";
import { Switch } from "@workspace/ui/components/switch";
import { useState } from "react";
import { CompetitorComparison } from "@/components/geo/recommendations/competitor-comparison";
import { recommendationKeys } from "@/components/geo/recommendations/labels";
import { RecommendationCard } from "@/components/geo/recommendations/recommendation-card";
import { GeoEmptyState } from "@/components/geo/shell/empty-state";
import { GeoPageFrame } from "@/components/geo/shell/page-frame";
import { useGeoViewer } from "@/components/geo/shell/use-geo-viewer";
import { errorMessage, formatDateTime } from "@/components/geo/site-pages/site-labels";
import { pageHead } from "@/lib/route-head";
import {
	getCompetitorComparisonFn,
	listRecommendationsFn,
	regenerateRecommendationsFn,
} from "@/server/geo/recommendations";
import type { RecommendationItem } from "@/server/geo/recommendations-core";

export const Route = createFileRoute("/_authed/app/org/$org/geo/recommendations")({
	staticData: { crumb: "提升建议" },
	head: pageHead({ description: "想被 AI 更多提到，官网和站外该补什么。" }),
	component: GeoRecommendationsPage,
});

const SECTION_HINTS: Record<GeoRecommendationKind, string> = {
	CONTENT_GAP: "AI 推荐竞品时引用了这些内容，我们的官网缺少或写得不够具体。",
	THIRD_PARTY_CHANNEL: "AI 经常引用这些平台上的内容来介绍竞品，而这些平台上还看不到我们。",
	SITE_FIX: "这些问题会让 AI 和搜索引擎读不到或读错官网内容。",
	FACT_CORRECTION: "AI 回答里关于我们的错误说法，需要在官网和常被引用的平台上更正。",
};

function ItemList({
	items,
	organizationId,
	orgSlug,
}: {
	items: RecommendationItem[];
	organizationId: string;
	orgSlug: string;
}) {
	return (
		<div className="flex flex-col gap-3">
			{items.map((item) => (
				<RecommendationCard key={item.id} item={item} organizationId={organizationId} orgSlug={orgSlug} />
			))}
		</div>
	);
}

function Section({
	kind,
	items,
	organizationId,
	orgSlug,
}: {
	kind: GeoRecommendationKind;
	items: RecommendationItem[];
	organizationId: string;
	orgSlug: string;
}) {
	const groups =
		kind === "CONTENT_GAP"
			? GEO_ON_SITE_CONTENT_TYPES.map((type) => ({
					type,
					items: items.filter((item) => item.contentType === type),
				})).filter((group) => group.items.length > 0)
			: null;
	return (
		<Card>
			<CardHeader>
				<CardTitle className="text-base">
					{GEO_RECOMMENDATION_KIND_LABELS[kind]}
					<span className="ml-2 text-sm font-normal text-muted-foreground">{items.length} 项</span>
				</CardTitle>
				<CardDescription>{SECTION_HINTS[kind]}</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-5">
				{items.length === 0 ? (
					<p className="text-sm text-muted-foreground">暂时没有需要处理的事项。</p>
				) : groups ? (
					groups.map((group) => (
						<div key={group.type} className="flex flex-col gap-2">
							<p className="text-sm font-medium">{GEO_CITED_CONTENT_TYPE_LABELS[group.type as GeoCitedContentType]}</p>
							<ItemList items={group.items} organizationId={organizationId} orgSlug={orgSlug} />
						</div>
					))
				) : (
					<ItemList items={items} organizationId={organizationId} orgSlug={orgSlug} />
				)}
			</CardContent>
		</Card>
	);
}

function RegenerateButton({ organizationId }: { organizationId: string }) {
	const viewer = useGeoViewer();
	const queryClient = useQueryClient();
	const [queued, setQueued] = useState(false);
	const regenerate = useMutation({
		mutationFn: () => regenerateRecommendationsFn({ data: { organizationId } }),
		onSuccess: () => {
			setQueued(true);
			setTimeout(() => queryClient.invalidateQueries({ queryKey: recommendationKeys.all(organizationId) }), 15_000);
		},
	});
	if (!viewer.can("recommendation.generate")) return null;
	return (
		<div className="flex flex-col items-end gap-1">
			<Button size="sm" variant="outline" onClick={() => regenerate.mutate()} disabled={regenerate.isPending}>
				<IconRefresh />
				重新生成
			</Button>
			{queued && <span className="text-xs text-muted-foreground">已提交，稍后刷新即可看到结果</span>}
			{regenerate.error && <span className="text-xs text-destructive">{errorMessage(regenerate.error)}</span>}
		</div>
	);
}

const SECTION_ORDER: GeoRecommendationKind[] = ["CONTENT_GAP", "THIRD_PARTY_CHANNEL", "SITE_FIX", "FACT_CORRECTION"];

function Recommendations({
	data,
	organizationId,
	orgSlug,
}: {
	data: Awaited<ReturnType<typeof listRecommendationsFn>>;
	organizationId: string;
	orgSlug: string;
}) {
	const [showDecided, setShowDecided] = useState(false);
	if (data.items.length === 0) {
		return (
			<GeoEmptyState
				title="还没有建议"
				description="完成一轮采样和评估、并采集官网后，系统会自动生成建议；每天也会自动更新一次。"
			/>
		);
	}
	const items = data.items.filter((item) => showDecided || item.status === "OPEN");
	const decided = data.items.length - data.items.filter((item) => item.status === "OPEN").length;
	return (
		<>
			<div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
				<span>{data.lastGeneratedAt && `更新于 ${formatDateTime(data.lastGeneratedAt)}`}</span>
				{decided > 0 && (
					<div className="flex items-center gap-2">
						<Switch id="show-decided" checked={showDecided} onCheckedChange={setShowDecided} />
						<Label htmlFor="show-decided">显示已忽略和已转工单的 {decided} 项</Label>
					</div>
				)}
			</div>
			{SECTION_ORDER.map((kind) => (
				<Section
					key={kind}
					kind={kind}
					items={items.filter((item) => item.kind === kind)}
					organizationId={organizationId}
					orgSlug={orgSlug}
				/>
			))}
		</>
	);
}

function ComparisonCard({ organizationId }: { organizationId: string }) {
	const comparison = useQuery({
		queryKey: recommendationKeys.comparison(organizationId),
		queryFn: () => getCompetitorComparisonFn({ data: { organizationId } }),
	});
	return (
		<Card>
			<CardHeader>
				<CardTitle className="text-base">与竞品对比</CardTitle>
				<CardDescription>同一组问题下，AI 提到我们和各竞品的比例，以及 AI 引用了各家哪些内容。</CardDescription>
			</CardHeader>
			<CardContent>
				{comparison.isLoading ? (
					<Skeleton className="h-40 w-full" />
				) : comparison.error ? (
					<p className="text-sm text-destructive">{errorMessage(comparison.error)}</p>
				) : comparison.data ? (
					<CompetitorComparison comparison={comparison.data} />
				) : null}
			</CardContent>
		</Card>
	);
}

function GeoRecommendationsPage() {
	const viewer = useGeoViewer();
	const { org } = Route.useParams();
	const organizationId = viewer.organizationId;
	const list = useQuery({
		queryKey: recommendationKeys.list(organizationId),
		queryFn: () => listRecommendationsFn({ data: { organizationId } }),
	});

	return (
		<GeoPageFrame
			title="提升建议"
			description="根据 AI 的真实回答和官网现状，列出想被 AI 更多提到该做的事，按影响从大到小排列。"
			actions={<RegenerateButton organizationId={organizationId} />}
		>
			{list.isLoading ? (
				<Skeleton className="h-64 w-full" />
			) : list.error ? (
				<GeoEmptyState title="加载失败" description={errorMessage(list.error)} />
			) : list.data ? (
				<Recommendations data={list.data} organizationId={organizationId} orgSlug={org} />
			) : null}
			<ComparisonCard organizationId={organizationId} />
		</GeoPageFrame>
	);
}
