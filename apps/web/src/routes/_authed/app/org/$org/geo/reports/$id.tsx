import { createFileRoute } from "@tanstack/react-router";
import { GeoReportDetail } from "@/components/geo/reports/report-detail";
import { GeoPageFrame } from "@/components/geo/shell/page-frame";
import { pageHead } from "@/lib/route-head";

export const Route = createFileRoute("/_authed/app/org/$org/geo/reports/$id")({
	staticData: { crumb: "报告详情" },
	head: pageHead({ description: "报告快照、方法说明、样本量与导出文件。" }),
	component: GeoReportDetailPage,
});

function GeoReportDetailPage() {
	const { id } = Route.useParams();
	return (
		<GeoPageFrame title="报告详情" description="报告快照、方法说明、样本量与导出文件。">
			<GeoReportDetail reportId={id} />
		</GeoPageFrame>
	);
}
