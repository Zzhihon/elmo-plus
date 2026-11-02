import { createFileRoute } from "@tanstack/react-router";
import { GeoEmptyState } from "@/components/geo/shell/empty-state";
import { GeoPageFrame } from "@/components/geo/shell/page-frame";
import { pageHead } from "@/lib/route-head";

export const Route = createFileRoute("/_authed/app/org/$org/geo/sources")({
	staticData: { crumb: "官网来源" },
	head: pageHead({ description: "授权官网、域名白名单、栏目、采集策略与上次同步。" }),
	component: GeoSourcesPage,
});

function GeoSourcesPage() {
	return (
		<GeoPageFrame title="官网来源" description="授权官网、域名白名单、栏目、采集策略与上次同步。">
			<GeoEmptyState />
		</GeoPageFrame>
	);
}
