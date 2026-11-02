import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Button, buttonVariants } from "@workspace/ui/components/button";
import { Skeleton } from "@workspace/ui/components/skeleton";
import { useState } from "react";
import {
	ObservationAnswer,
	ObservationCitations,
	ObservationNotices,
	ObservationProvenance,
} from "@/components/geo/observations/observation-detail";
import { GeoObservationReviewPanel } from "@/components/geo/review/observation-review-panel";
import { observationKeys } from "@/components/geo/sampling/keys";
import { ResampleDialog } from "@/components/geo/sampling/resample-dialog";
import { GeoPlatformBadge, GeoSurfaceModeBadge } from "@/components/geo/shell/evidence-badge";
import { GeoPageFrame } from "@/components/geo/shell/page-frame";
import { GeoRunStatusBadge } from "@/components/geo/shell/status-badge";
import { useGeoViewer } from "@/components/geo/shell/use-geo-viewer";
import { pageHead } from "@/lib/route-head";
import { getObservationFn } from "@/server/geo/observations";

export const Route = createFileRoute("/_authed/app/org/$org/geo/observations/$id")({
	staticData: { crumb: "证据详情" },
	head: pageHead({ description: "原始回答、引用列表与评估版本。" }),
	component: GeoObservationDetailPage,
});

const TERMINAL_RUN = new Set([
	"VALID",
	"PARTIAL",
	"UNAVAILABLE",
	"NEEDS_MANUAL",
	"FAILED",
	"RATE_LIMITED",
	"TIMEOUT",
	"CAPTCHA",
	"NETWORK_ERROR",
]);

function GeoObservationDetailPage() {
	const { organization } = Route.useRouteContext();
	const { id } = Route.useParams();
	const viewer = useGeoViewer();
	const [resampling, setResampling] = useState(false);
	const detail = useQuery({
		queryKey: observationKeys.detail(organization.id, id),
		queryFn: () => getObservationFn({ data: { organizationId: organization.id, observationId: id } }),
	});
	const observation = detail.data;
	const run = observation?.run;

	return (
		<GeoPageFrame
			title="证据详情"
			description="原始回答、引用列表与评估版本。"
			actions={
				observation && (
					<>
						<a
							href={`/api/geo/${encodeURIComponent(organization.slug)}/observations/${observation.id}/export`}
							className={buttonVariants({ variant: "outline" })}
							download
						>
							导出 JSON
						</a>
						{run && viewer.can("sampling.run") && TERMINAL_RUN.has(run.status) && (
							<Button variant="outline" onClick={() => setResampling(true)}>
								重新采样
							</Button>
						)}
					</>
				)
			}
		>
			{detail.error && <p className="text-sm text-destructive">{detail.error.message}</p>}
			{!observation && !detail.error && <Skeleton className="h-96 w-full" />}
			{observation && (
				<>
					<div className="flex flex-wrap items-center gap-2">
						<GeoPlatformBadge platform={observation.target.platform} />
						<GeoSurfaceModeBadge mode={observation.target.surfaceMode} />
						<GeoRunStatusBadge status={observation.status} />
					</div>
					<ObservationNotices observation={observation} />
					<ObservationAnswer observation={observation} />
					<ObservationCitations observation={observation} />
					<ObservationProvenance observation={observation} />
					<GeoObservationReviewPanel observation={observation} />
				</>
			)}
			{resampling && run && <ResampleDialog runId={run.id} onClose={() => setResampling(false)} />}
		</GeoPageFrame>
	);
}
