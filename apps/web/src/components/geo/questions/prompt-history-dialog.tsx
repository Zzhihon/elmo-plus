import { useQuery } from "@tanstack/react-query";
import { GEO_PROMPT_TIER_LABELS } from "@workspace/geo-domain";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@workspace/ui/components/dialog";
import { Skeleton } from "@workspace/ui/components/skeleton";
import { formatGeoDateTime, geoActorLabel } from "@/components/geo/brands/format";
import { GeoPromptStatusBadge } from "@/components/geo/shell/status-badge";
import { getGeoPromptFn } from "@/server/geo/prompts";

export function PromptHistoryDialog({
	organizationId,
	promptId,
	members,
	onOpenChange,
}: {
	organizationId: string;
	promptId: string;
	members: ReadonlyMap<string, string>;
	onOpenChange: (open: boolean) => void;
}) {
	const { data, isLoading } = useQuery({
		queryKey: ["geo-prompt", organizationId, promptId],
		queryFn: () => getGeoPromptFn({ data: { organizationId, promptId } }),
	});

	return (
		<Dialog open onOpenChange={onOpenChange}>
			<DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>修订历史</DialogTitle>
					<DialogDescription>修订版本不可修改；冻结的测试集引用的是冻结当时的修订号。</DialogDescription>
				</DialogHeader>
				{isLoading && <Skeleton className="h-24 w-full" />}
				{data && (
					<div className="flex flex-col gap-3">
						<div className="flex flex-wrap items-center gap-2 text-sm">
							<GeoPromptStatusBadge status={data.status} />
							<span className="text-muted-foreground">当前修订 r{data.currentRevision}</span>
							{data.reviewNote && <span className="text-muted-foreground">审核意见：{data.reviewNote}</span>}
						</div>
						<ol className="flex flex-col gap-3">
							{data.revisions.map((revision) => (
								<li key={revision.revision} className="rounded-lg border p-3 text-sm">
									<div className="flex flex-wrap items-center justify-between gap-2">
										<span className="font-medium">r{revision.revision}</span>
										<span className="text-muted-foreground">
											{formatGeoDateTime(revision.createdAt)} · {geoActorLabel(revision.editorId, members)}
										</span>
									</div>
									<p className="mt-1">{revision.snapshot.question}</p>
									<p className="mt-1 text-muted-foreground">
										{[
											revision.snapshot.buyerRoleTitle,
											revision.snapshot.intent,
											revision.snapshot.productLine,
											revision.snapshot.geoRegion,
											revision.snapshot.priority,
											GEO_PROMPT_TIER_LABELS[revision.snapshot.tier],
										]
											.filter(Boolean)
											.join(" · ")}
									</p>
								</li>
							))}
						</ol>
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
}
