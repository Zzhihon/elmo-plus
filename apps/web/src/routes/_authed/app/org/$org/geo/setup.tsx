import { createFileRoute } from "@tanstack/react-router";
import { GeoSetupView } from "@/components/geo/setup/setup-view";
import { pageHead } from "@/lib/route-head";

export const Route = createFileRoute("/_authed/app/org/$org/geo/setup")({
	staticData: { crumb: "监测问题与竞品" },
	head: pageHead({ description: "挑选要监测的买家问题，确认需要对比的竞品。" }),
	component: GeoSetupPage,
});

function GeoSetupPage() {
	const { organization } = Route.useRouteContext();
	return <GeoSetupView organizationId={organization.id} />;
}
