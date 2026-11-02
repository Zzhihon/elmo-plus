import { createFileRoute } from "@tanstack/react-router";
import { GeoQuestionsView } from "@/components/geo/questions/questions-view";
import { pageHead } from "@/lib/route-head";

export const Route = createFileRoute("/_authed/app/org/$org/geo/questions")({
	staticData: { crumb: "问法库" },
	head: pageHead({ description: "按买方角色维护问法，管理测试集版本与导入。" }),
	component: GeoQuestionsPage,
});

function GeoQuestionsPage() {
	const { organization } = Route.useRouteContext();
	return <GeoQuestionsView organizationId={organization.id} />;
}
