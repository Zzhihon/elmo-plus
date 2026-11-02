import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Button } from "@workspace/ui/components/button";
import { useState } from "react";
import { ImportEvidenceDialog } from "@/components/geo/observations/import-dialog";
import { ObservationFilters, ObservationList } from "@/components/geo/observations/observation-list";
import { type ObservationSearch, observationSearchSchema } from "@/components/geo/observations/search";
import { GeoPageFrame } from "@/components/geo/shell/page-frame";
import { useGeoViewer } from "@/components/geo/shell/use-geo-viewer";
import { pageHead } from "@/lib/route-head";

export const Route = createFileRoute("/_authed/app/org/$org/geo/observations/")({
	staticData: { crumb: "证据库" },
	validateSearch: observationSearchSchema,
	head: pageHead({ description: "查看原始回答、引用与抽取结果，进行证据复核。" }),
	component: GeoObservationsPage,
});

function GeoObservationsPage() {
	const search = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const viewer = useGeoViewer();
	const [importing, setImporting] = useState(false);
	const update = (next: Partial<ObservationSearch>) =>
		navigate({ search: (prev) => ({ ...prev, ...next, page: next.page ?? undefined }) });

	return (
		<GeoPageFrame
			title="证据库"
			description="按问题、平台、源模式和日期检索原始回答与引用。证据不可修改，更正只会生成新的评估版本。"
			actions={
				viewer.can("evidence.import") && (
					<Button variant="outline" onClick={() => setImporting(true)}>
						导入证据
					</Button>
				)
			}
			filters={<ObservationFilters search={search} onChange={update} />}
		>
			<ObservationList search={search} onPageChange={(page) => update({ page })} />
			{importing && <ImportEvidenceDialog open onOpenChange={setImporting} />}
		</GeoPageFrame>
	);
}
