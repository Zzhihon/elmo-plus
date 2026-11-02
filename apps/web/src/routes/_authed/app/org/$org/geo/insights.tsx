import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { GeoInsightsView } from "@/components/geo/insights/insights-view";
import { type InsightSearch, insightSearchSchema } from "@/components/geo/insights/search";
import { GeoPageFrame } from "@/components/geo/shell/page-frame";
import { pageHead } from "@/lib/route-head";

export const Route = createFileRoute("/_authed/app/org/$org/geo/insights")({
	staticData: { crumb: "诊断分析" },
	validateSearch: insightSearchSchema,
	head: pageHead({ description: "提及、推荐、竞品、引用来源与问题矩阵。" }),
	component: GeoInsightsPage,
});

function GeoInsightsPage() {
	const search = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const update = (next: Partial<InsightSearch>) => navigate({ search: (prev) => ({ ...prev, ...next }) });
	return (
		<GeoPageFrame
			title="诊断分析"
			description="按固定问法集版本、平台与采样方式分别统计提及、推荐、竞品、引用来源与错误描述；每个数字都可下钻到采样证据。"
		>
			<GeoInsightsView search={search} onChange={update} />
		</GeoPageFrame>
	);
}
