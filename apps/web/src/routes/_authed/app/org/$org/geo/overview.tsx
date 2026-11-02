import { createFileRoute } from "@tanstack/react-router";
import { GeoEmptyState } from "@/components/geo/shell/empty-state";
import { GeoPageFrame } from "@/components/geo/shell/page-frame";
import { pageHead } from "@/lib/route-head";

export const Route = createFileRoute("/_authed/app/org/$org/geo/overview")({
	staticData: { crumb: "总览" },
	head: pageHead({ description: "总体趋势、P0 缺口、近七日结果与待审核事项。" }),
	component: GeoOverviewPage,
});

function GeoOverviewPage() {
	return (
		<GeoPageFrame title="总览" description="总体趋势、P0 缺口、近七日结果与待审核事项。">
			<GeoEmptyState />
		</GeoPageFrame>
	);
}
