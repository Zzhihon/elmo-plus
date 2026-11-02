import { createFileRoute } from "@tanstack/react-router";
import { GeoEmptyState } from "@/components/geo/shell/empty-state";
import { GeoPageFrame } from "@/components/geo/shell/page-frame";
import { pageHead } from "@/lib/route-head";

export const Route = createFileRoute("/_authed/app/org/$org/geo/site-audit")({
	staticData: { crumb: "站点审计" },
	head: pageHead({ description: "可抓取性、元数据缺口、失效页面与内容建议。" }),
	component: GeoSiteAuditPage,
});

function GeoSiteAuditPage() {
	return (
		<GeoPageFrame title="站点审计" description="可抓取性、元数据缺口、失效页面与内容建议。">
			<GeoEmptyState />
		</GeoPageFrame>
	);
}
