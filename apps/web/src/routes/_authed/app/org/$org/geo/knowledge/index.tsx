import { createFileRoute } from "@tanstack/react-router";
import { GeoEmptyState } from "@/components/geo/shell/empty-state";
import { GeoPageFrame } from "@/components/geo/shell/page-frame";
import { pageHead } from "@/lib/route-head";

export const Route = createFileRoute("/_authed/app/org/$org/geo/knowledge/")({
	staticData: { crumb: "可信知识" },
	head: pageHead({ description: "官网抽取事实、客户资料、资质、产品、案例、冲突与审批。" }),
	component: GeoKnowledgePage,
});

function GeoKnowledgePage() {
	return (
		<GeoPageFrame title="可信知识" description="官网抽取事实、客户资料、资质、产品、案例、冲突与审批。">
			<GeoEmptyState />
		</GeoPageFrame>
	);
}
