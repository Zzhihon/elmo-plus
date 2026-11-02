import { createFileRoute } from "@tanstack/react-router";
import { GeoEmptyState } from "@/components/geo/shell/empty-state";
import { GeoPageFrame } from "@/components/geo/shell/page-frame";
import { pageHead } from "@/lib/route-head";

export const Route = createFileRoute("/_authed/app/org/$org/geo/insights")({
	staticData: { crumb: "诊断分析" },
	head: pageHead({ description: "提及、推荐、竞品、引用来源与问题矩阵。" }),
	component: GeoInsightsPage,
});

function GeoInsightsPage() {
	return (
		<GeoPageFrame title="诊断分析" description="提及、推荐、竞品、引用来源与问题矩阵。">
			<GeoEmptyState />
		</GeoPageFrame>
	);
}
