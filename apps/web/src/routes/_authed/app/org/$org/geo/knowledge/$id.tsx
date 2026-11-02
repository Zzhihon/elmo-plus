import { createFileRoute, useRouteContext } from "@tanstack/react-router";
import { Alert, AlertDescription } from "@workspace/ui/components/alert";
import { Skeleton } from "@workspace/ui/components/skeleton";
import { ClaimDetailView } from "@/components/geo/knowledge/claim-detail";
import { errorMessage } from "@/components/geo/knowledge/labels";
import { useKnowledgeClaim } from "@/components/geo/knowledge/queries";
import { GeoPageFrame } from "@/components/geo/shell/page-frame";
import { pageHead } from "@/lib/route-head";

export const Route = createFileRoute("/_authed/app/org/$org/geo/knowledge/$id")({
	staticData: { crumb: "知识详情" },
	head: pageHead({ description: "事实主张、来源定位、审核历史与新旧差异。" }),
	component: GeoKnowledgeDetailPage,
});

function GeoKnowledgeDetailPage() {
	const { id } = Route.useParams();
	const { organization } = useRouteContext({ from: "/_authed/app/org/$org/geo" });
	const { data, isLoading, error } = useKnowledgeClaim(organization.id, id);
	return (
		<GeoPageFrame title="知识详情" description="事实主张、来源定位、审核历史与新旧差异。">
			{isLoading && <Skeleton className="h-96 w-full" />}
			{error && (
				<Alert variant="destructive">
					<AlertDescription>{errorMessage(error)}</AlertDescription>
				</Alert>
			)}
			{data && <ClaimDetailView detail={data} />}
		</GeoPageFrame>
	);
}
