import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@workspace/ui/components/button";
import { useState } from "react";
import { z } from "zod";
import { CreateReportDialog, GeoReportList } from "@/components/geo/reports/report-list";
import { GeoPageFrame } from "@/components/geo/shell/page-frame";
import { useGeoViewer } from "@/components/geo/shell/use-geo-viewer";
import { pageHead } from "@/lib/route-head";

export const Route = createFileRoute("/_authed/app/org/$org/geo/reports/")({
	staticData: { crumb: "报告" },
	validateSearch: z.object({ page: z.coerce.number().int().min(1).optional().catch(undefined) }),
	head: pageHead({ description: "月报、基线、问题解释与导出历史。" }),
	component: GeoReportsPage,
});

function GeoReportsPage() {
	const { page } = Route.useSearch();
	const navigate = Route.useNavigate();
	const viewer = useGeoViewer();
	const [creating, setCreating] = useState(false);
	return (
		<GeoPageFrame
			title="报告"
			description="月报与专项报告保存生成时的指标快照，历史报告可复现；支持审核与 PDF/CSV 导出。"
			actions={viewer.can("report.generate") && <Button onClick={() => setCreating(true)}>生成报告</Button>}
		>
			<GeoReportList page={page ?? 1} onPageChange={(next) => navigate({ search: { page: next } })} />
			{creating && <CreateReportDialog onClose={() => setCreating(false)} />}
		</GeoPageFrame>
	);
}
