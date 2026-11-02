import { createFileRoute } from "@tanstack/react-router";
import { GeoEmptyState } from "@/components/geo/shell/empty-state";
import { GeoPageFrame } from "@/components/geo/shell/page-frame";
import { pageHead } from "@/lib/route-head";

export const Route = createFileRoute("/_authed/app/org/$org/geo/questions")({
	staticData: { crumb: "问法库" },
	head: pageHead({ description: "按买方角色维护问法，管理测试集版本与导入。" }),
	component: GeoQuestionsPage,
});

function GeoQuestionsPage() {
	return (
		<GeoPageFrame title="问法库" description="按买方角色维护问法，管理测试集版本与导入。">
			<GeoEmptyState />
		</GeoPageFrame>
	);
}
