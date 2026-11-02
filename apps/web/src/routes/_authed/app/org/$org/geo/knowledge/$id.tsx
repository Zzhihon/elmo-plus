import { createFileRoute } from "@tanstack/react-router";
import { GeoEmptyState } from "@/components/geo/shell/empty-state";
import { GeoPageFrame } from "@/components/geo/shell/page-frame";
import { pageHead } from "@/lib/route-head";

export const Route = createFileRoute("/_authed/app/org/$org/geo/knowledge/$id")({
	staticData: { crumb: "知识详情" },
	head: pageHead({ description: "事实主张、来源定位、审核历史与新旧差异。" }),
	component: GeoKnowledgeDetailPage,
});

function GeoKnowledgeDetailPage() {
	return (
		<GeoPageFrame title="知识详情" description="事实主张、来源定位、审核历史与新旧差异。">
			<GeoEmptyState />
		</GeoPageFrame>
	);
}
