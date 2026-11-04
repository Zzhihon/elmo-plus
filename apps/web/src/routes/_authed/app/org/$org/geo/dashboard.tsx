import { createFileRoute } from "@tanstack/react-router";
import { GeoDashboardView } from "@/components/geo/dashboard/dashboard-view";
import { pageHead } from "@/lib/route-head";

export const Route = createFileRoute("/_authed/app/org/$org/geo/dashboard")({
	staticData: { crumb: "曝光看板" },
	head: pageHead({ description: "我们的品牌在主流 AI 回答里被看到、被推荐的情况。" }),
	component: GeoDashboardView,
});
