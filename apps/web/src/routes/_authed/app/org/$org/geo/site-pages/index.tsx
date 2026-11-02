import { createFileRoute } from "@tanstack/react-router";
import { GeoEmptyState } from "@/components/geo/shell/empty-state";
import { GeoPageFrame } from "@/components/geo/shell/page-frame";
import { pageHead } from "@/lib/route-head";

export const Route = createFileRoute("/_authed/app/org/$org/geo/site-pages/")({
	staticData: { crumb: "官网页面" },
	head: pageHead({ description: "页面列表、来源快照、解析状态、内容版本和差异。" }),
	component: GeoSitePagesPage,
});

function GeoSitePagesPage() {
	return (
		<GeoPageFrame title="官网页面" description="页面列表、来源快照、解析状态、内容版本和差异。">
			<GeoEmptyState />
		</GeoPageFrame>
	);
}
