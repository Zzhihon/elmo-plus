import { createFileRoute } from "@tanstack/react-router";
import { GeoEmptyState } from "@/components/geo/shell/empty-state";
import { GeoPageFrame } from "@/components/geo/shell/page-frame";
import { pageHead } from "@/lib/route-head";

export const Route = createFileRoute("/_authed/app/org/$org/geo/observations/$id")({
	staticData: { crumb: "证据详情" },
	head: pageHead({ description: "原始回答、引用列表与评估版本。" }),
	component: GeoObservationDetailPage,
});

function GeoObservationDetailPage() {
	return (
		<GeoPageFrame title="证据详情" description="原始回答、引用列表与评估版本。">
			<GeoEmptyState />
		</GeoPageFrame>
	);
}
