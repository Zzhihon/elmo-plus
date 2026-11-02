import { createFileRoute } from "@tanstack/react-router";
import { GeoEmptyState } from "@/components/geo/shell/empty-state";
import { GeoPageFrame } from "@/components/geo/shell/page-frame";
import { pageHead } from "@/lib/route-head";

export const Route = createFileRoute("/_authed/app/org/$org/geo/brands")({
	staticData: { crumb: "品牌与竞品" },
	head: pageHead({ description: "管理品牌、产品、别名、竞品和域名。" }),
	component: GeoBrandsPage,
});

function GeoBrandsPage() {
	return (
		<GeoPageFrame title="品牌与竞品" description="管理品牌、产品、别名、竞品和域名。">
			<GeoEmptyState />
		</GeoPageFrame>
	);
}
