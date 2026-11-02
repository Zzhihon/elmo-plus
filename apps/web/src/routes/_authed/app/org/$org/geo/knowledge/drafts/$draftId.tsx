import { createFileRoute, useRouteContext } from "@tanstack/react-router";
import { Alert, AlertDescription } from "@workspace/ui/components/alert";
import { Skeleton } from "@workspace/ui/components/skeleton";
import { DraftDetailView } from "@/components/geo/knowledge/draft-detail";
import { errorMessage } from "@/components/geo/knowledge/labels";
import { useGeoDraft } from "@/components/geo/knowledge/queries";
import { GeoPageFrame } from "@/components/geo/shell/page-frame";
import { pageHead } from "@/lib/route-head";

export const Route = createFileRoute("/_authed/app/org/$org/geo/knowledge/drafts/$draftId")({
	staticData: { crumb: "内容草稿" },
	head: pageHead({ description: "草稿版本、事实核对、技术与市场审核、导出与发布登记。" }),
	component: GeoDraftPage,
});

function GeoDraftPage() {
	const { draftId } = Route.useParams();
	const { organization } = useRouteContext({ from: "/_authed/app/org/$org/geo" });
	const { data, isLoading, error } = useGeoDraft(organization.id, draftId);
	return (
		<GeoPageFrame
			title={data?.item.title ?? "内容草稿"}
			description="草稿版本、事实核对、技术与市场审核、导出与发布登记。"
		>
			{isLoading && <Skeleton className="h-96 w-full" />}
			{error && (
				<Alert variant="destructive">
					<AlertDescription>{errorMessage(error)}</AlertDescription>
				</Alert>
			)}
			{data && <DraftDetailView detail={data} />}
		</GeoPageFrame>
	);
}
