import { createFileRoute } from "@tanstack/react-router";
import { GeoEmptyState } from "@/components/geo/shell/empty-state";
import { GeoPageFrame } from "@/components/geo/shell/page-frame";
import { pageHead } from "@/lib/route-head";

export const Route = createFileRoute("/_authed/app/org/$org/geo/observations/")({
	staticData: { crumb: "证据库" },
	head: pageHead({ description: "查看原始回答、引用与抽取结果，进行证据复核。" }),
	component: GeoObservationsPage,
});

function GeoObservationsPage() {
	return (
		<GeoPageFrame title="证据库" description="查看原始回答、引用与抽取结果，进行证据复核。">
			<GeoEmptyState />
		</GeoPageFrame>
	);
}
