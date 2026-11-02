import { createFileRoute } from "@tanstack/react-router";
import { GeoEmptyState } from "@/components/geo/shell/empty-state";
import { GeoPageFrame } from "@/components/geo/shell/page-frame";
import { pageHead } from "@/lib/route-head";

export const Route = createFileRoute("/_authed/app/org/$org/geo/tasks/")({
	staticData: { crumb: "优化工单" },
	head: pageHead({ description: "看板、责任人、审批、发布凭证与复测。" }),
	component: GeoTasksPage,
});

function GeoTasksPage() {
	return (
		<GeoPageFrame title="优化工单" description="看板、责任人、审批、发布凭证与复测。">
			<GeoEmptyState />
		</GeoPageFrame>
	);
}
