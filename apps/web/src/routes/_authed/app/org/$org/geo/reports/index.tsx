import { createFileRoute } from "@tanstack/react-router";
import { GeoEmptyState } from "@/components/geo/shell/empty-state";
import { GeoPageFrame } from "@/components/geo/shell/page-frame";
import { pageHead } from "@/lib/route-head";

export const Route = createFileRoute("/_authed/app/org/$org/geo/reports/")({
	staticData: { crumb: "报告" },
	head: pageHead({ description: "月报、基线、问题解释与导出历史。" }),
	component: GeoReportsPage,
});

function GeoReportsPage() {
	return (
		<GeoPageFrame title="报告" description="月报、基线、问题解释与导出历史。">
			<GeoEmptyState />
		</GeoPageFrame>
	);
}
