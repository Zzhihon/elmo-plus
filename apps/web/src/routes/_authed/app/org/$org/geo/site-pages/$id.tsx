import { createFileRoute } from "@tanstack/react-router";
import { GeoEmptyState } from "@/components/geo/shell/empty-state";
import { GeoPageFrame } from "@/components/geo/shell/page-frame";
import { pageHead } from "@/lib/route-head";

export const Route = createFileRoute("/_authed/app/org/$org/geo/site-pages/$id")({
	staticData: { crumb: "页面详情" },
	head: pageHead({ description: "页面版本、原始快照与解析结果。" }),
	component: GeoSitePageDetailPage,
});

function GeoSitePageDetailPage() {
	return (
		<GeoPageFrame title="页面详情" description="页面版本、原始快照与解析结果。">
			<GeoEmptyState />
		</GeoPageFrame>
	);
}
