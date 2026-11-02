import { createFileRoute } from "@tanstack/react-router";
import { GeoBrandsView } from "@/components/geo/brands/brands-view";
import { pageHead } from "@/lib/route-head";

export const Route = createFileRoute("/_authed/app/org/$org/geo/brands")({
	staticData: { crumb: "品牌与竞品" },
	head: pageHead({ description: "管理品牌、产品、别名、竞品和域名。" }),
	component: GeoBrandsPage,
});

function GeoBrandsPage() {
	const { organization } = Route.useRouteContext();
	return <GeoBrandsView organizationId={organization.id} />;
}
