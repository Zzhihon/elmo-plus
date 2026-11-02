import { createFileRoute, useRouteContext } from "@tanstack/react-router";
import { Alert, AlertDescription } from "@workspace/ui/components/alert";
import { Skeleton } from "@workspace/ui/components/skeleton";
import { AssetDetailView } from "@/components/geo/knowledge/asset-detail";
import { errorMessage } from "@/components/geo/knowledge/labels";
import { useKnowledgeAsset } from "@/components/geo/knowledge/queries";
import { GeoPageFrame } from "@/components/geo/shell/page-frame";
import { pageHead } from "@/lib/route-head";

export const Route = createFileRoute("/_authed/app/org/$org/geo/knowledge/assets/$assetId")({
	staticData: { crumb: "客户资料" },
	head: pageHead({ description: "客户原件、确认状态、有效期与从原件登记的主张。" }),
	component: GeoKnowledgeAssetPage,
});

function GeoKnowledgeAssetPage() {
	const { assetId } = Route.useParams();
	const { organization } = useRouteContext({ from: "/_authed/app/org/$org/geo" });
	const { data, isLoading, error } = useKnowledgeAsset(organization.id, assetId);
	return (
		<GeoPageFrame title={data?.asset.title ?? "客户资料"} description="客户原件、确认状态、有效期与从原件登记的主张。">
			{isLoading && <Skeleton className="h-96 w-full" />}
			{error && (
				<Alert variant="destructive">
					<AlertDescription>{errorMessage(error)}</AlertDescription>
				</Alert>
			)}
			{data && <AssetDetailView detail={data} />}
		</GeoPageFrame>
	);
}
