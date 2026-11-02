import { createFileRoute } from "@tanstack/react-router";
import { GeoEmptyState } from "@/components/geo/shell/empty-state";
import { GeoPageFrame } from "@/components/geo/shell/page-frame";
import { pageHead } from "@/lib/route-head";

export const Route = createFileRoute("/_authed/app/org/$org/geo/sampling")({
	staticData: { crumb: "采样中心" },
	head: pageHead({ description: "查看平台、源模式、任务状态与成本预算，发起采样或导入证据。" }),
	component: GeoSamplingPage,
});

function GeoSamplingPage() {
	return (
		<GeoPageFrame title="采样中心" description="查看平台、源模式、任务状态与成本预算，发起采样或导入证据。">
			<GeoEmptyState />
		</GeoPageFrame>
	);
}
