import { useQuery } from "@tanstack/react-query";
import { Badge } from "@workspace/ui/components/badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@workspace/ui/components/dialog";
import { Skeleton } from "@workspace/ui/components/skeleton";
import { GeoEmptyState } from "@/components/geo/shell/empty-state";
import { getGeoBrandFn } from "@/server/geo/profile";
import { formatGeoDateTime, geoActorLabel } from "./format";

const FIELD_LABELS: Record<string, string> = {
	created: "创建",
	displayName: "显示名称",
	legalName: "法定名称",
	shortName: "简称",
	domains: "域名",
	officialUrl: "官网",
	regions: "区域",
	status: "启停状态",
	factStatus: "客户确认状态",
	products: "产品",
};

function Terms({ label, terms, tone }: { label: string; terms: string[]; tone: "add" | "remove" }) {
	if (terms.length === 0) return null;
	return (
		<div className="flex flex-wrap items-center gap-1.5 text-sm">
			<span className="text-muted-foreground">{label}</span>
			{terms.map((term) => (
				<Badge
					key={term}
					variant="outline"
					className={tone === "add" ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "line-through"}
				>
					{term}
				</Badge>
			))}
		</div>
	);
}

export function BrandHistoryDialog({
	organizationId,
	brandId,
	members,
	onOpenChange,
}: {
	organizationId: string;
	brandId: string | null;
	members: ReadonlyMap<string, string>;
	onOpenChange: (open: boolean) => void;
}) {
	const { data, isLoading } = useQuery({
		queryKey: ["geo-brand", organizationId, brandId],
		queryFn: () => getGeoBrandFn({ data: { organizationId, brandId: brandId as string } }),
		enabled: Boolean(brandId),
	});

	return (
		<Dialog open={Boolean(brandId)} onOpenChange={onOpenChange}>
			<DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>变更历史{data ? `：${data.displayName}` : ""}</DialogTitle>
					<DialogDescription>每次变更对应一个不可变的词典版本，评估结果引用的版本号可在此对照。</DialogDescription>
				</DialogHeader>
				{isLoading && <Skeleton className="h-24 w-full" />}
				{data && data.history.length === 0 && <GeoEmptyState title="暂无变更记录" />}
				<ol className="flex flex-col gap-3">
					{data?.history.map((entry) => (
						<li key={entry.version} className="rounded-lg border p-3">
							<div className="flex flex-wrap items-center justify-between gap-2 text-sm">
								<span className="font-medium">词典 v{entry.version}</span>
								<span className="text-muted-foreground">
									{formatGeoDateTime(entry.createdAt)} · {geoActorLabel(entry.createdBy, members)}
								</span>
							</div>
							{entry.changeNote && <p className="mt-1 text-sm">{entry.changeNote}</p>}
							<div className="mt-2 flex flex-col gap-1.5">
								<Terms label="新增别名" terms={entry.addedAliases} tone="add" />
								<Terms label="移除别名" terms={entry.removedAliases} tone="remove" />
								<Terms label="新增历史名称" terms={entry.addedHistoricalNames} tone="add" />
								<Terms label="移除历史名称" terms={entry.removedHistoricalNames} tone="remove" />
								{entry.changedFields.length > 0 && (
									<p className="text-sm text-muted-foreground">
										变更字段：{entry.changedFields.map((field) => FIELD_LABELS[field] ?? field).join("、")}
									</p>
								)}
							</div>
						</li>
					))}
				</ol>
			</DialogContent>
		</Dialog>
	);
}
