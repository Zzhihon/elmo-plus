import { createFileRoute, useRouteContext } from "@tanstack/react-router";
import { Alert, AlertDescription } from "@workspace/ui/components/alert";
import { Skeleton } from "@workspace/ui/components/skeleton";
import { GeoPageFrame } from "@/components/geo/shell/page-frame";
import { errorMessage } from "@/components/geo/tasks/labels";
import { useGeoTask } from "@/components/geo/tasks/queries";
import { GeoTaskDetailView } from "@/components/geo/tasks/task-detail";
import { pageHead } from "@/lib/route-head";

export const Route = createFileRoute("/_authed/app/org/$org/geo/tasks/$id")({
	staticData: { crumb: "工单详情" },
	head: pageHead({ description: "诊断证据、目标问法、审批记录、发布凭证与复测对比。" }),
	component: GeoTaskDetailPage,
});

function GeoTaskDetailPage() {
	const { id } = Route.useParams();
	const { organization } = useRouteContext({ from: "/_authed/app/org/$org/geo" });
	const { data, isLoading, error } = useGeoTask(organization.id, id);

	return (
		<GeoPageFrame
			title={data?.task.title ?? "工单详情"}
			description="诊断证据、目标问法、审批记录、发布凭证与复测对比。"
		>
			{isLoading && <Skeleton className="h-96 w-full" />}
			{error && (
				<Alert variant="destructive">
					<AlertDescription>{errorMessage(error)}</AlertDescription>
				</Alert>
			)}
			{data && <GeoTaskDetailView detail={data} orgSlug={organization.slug} />}
		</GeoPageFrame>
	);
}
