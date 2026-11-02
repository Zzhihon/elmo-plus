import { createFileRoute } from "@tanstack/react-router";
import { GeoEmptyState } from "@/components/geo/shell/empty-state";
import { GeoPageFrame } from "@/components/geo/shell/page-frame";
import { pageHead } from "@/lib/route-head";

export const Route = createFileRoute("/_authed/app/org/$org/geo/tasks/$id")({
	staticData: { crumb: "工单详情" },
	head: pageHead({ description: "诊断证据、目标问法、审批记录、发布凭证与复测对比。" }),
	component: GeoTaskDetailPage,
});

function GeoTaskDetailPage() {
	return (
		<GeoPageFrame title="工单详情" description="诊断证据、目标问法、审批记录、发布凭证与复测对比。">
			<GeoEmptyState />
		</GeoPageFrame>
	);
}
