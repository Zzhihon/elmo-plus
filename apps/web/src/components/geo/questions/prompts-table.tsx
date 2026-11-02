import { GEO_PROMPT_TIER_LABELS } from "@workspace/geo-domain";
import { Button } from "@workspace/ui/components/button";
import { GeoEmptyState } from "@/components/geo/shell/empty-state";
import { GeoPaginatedTable } from "@/components/geo/shell/paginated-table";
import { GeoPromptStatusBadge, GeoStatusBadge } from "@/components/geo/shell/status-badge";
import type { useGeoViewer } from "@/components/geo/shell/use-geo-viewer";
import type { GeoPromptRow } from "@/server/geo/prompts-core";
import type { PromptDialogAction } from "./prompt-action-dialog";

export function PromptsTable({
	data,
	viewer,
	onPageChange,
	onEdit,
	onAction,
	onHistory,
}: {
	data: { rows: GeoPromptRow[]; total: number; page: number; totalPages: number };
	viewer: ReturnType<typeof useGeoViewer>;
	onPageChange: (page: number) => void;
	onEdit: (prompt: GeoPromptRow) => void;
	onAction: (prompt: GeoPromptRow, action: PromptDialogAction) => void;
	onHistory: (prompt: GeoPromptRow) => void;
}) {
	const canWrite = viewer.can("prompt.write");
	const canReview = viewer.can("prompt.review");

	return (
		<GeoPaginatedTable
			rows={data.rows}
			rowKey={(row) => row.id}
			page={data.page}
			totalPages={data.totalPages}
			total={data.total}
			onPageChange={onPageChange}
			empty={
				<GeoEmptyState
					title="没有符合条件的问法"
					description="可新建问法或导入 CSV。问法需标注买方角色、意图、产品线和地区后提交业务审核。"
				/>
			}
			columns={[
				{
					key: "question",
					header: "问法",
					className: "max-w-sm whitespace-normal",
					cell: (row) => (
						<div className="flex flex-col gap-1">
							<span>{row.question}</span>
							{row.reviewNote && row.status === "REJECTED" && (
								<span className="text-xs text-destructive">驳回意见：{row.reviewNote}</span>
							)}
						</div>
					),
				},
				{ key: "role", header: "买方角色", cell: (row) => row.buyerRoleTitle ?? "—" },
				{
					key: "labels",
					header: "意图 / 产品线 / 地区",
					className: "whitespace-normal",
					cell: (row) => [row.intent, row.productLine, row.geoRegion].map((value) => value ?? "—").join(" / "),
				},
				{ key: "priority", header: "优先级", cell: (row) => row.priority },
				{
					key: "tier",
					header: "层级",
					cell: (row) => (
						<GeoStatusBadge label={GEO_PROMPT_TIER_LABELS[row.tier]} tone={row.tier === "CORE" ? "info" : "neutral"} />
					),
				},
				{ key: "status", header: "状态", cell: (row) => <GeoPromptStatusBadge status={row.status} /> },
				{
					key: "version",
					header: "测试集版本",
					cell: (row) => (row.latestFrozenSet ? `${row.latestFrozenSet.name} v${row.latestFrozenSet.version}` : "—"),
				},
				{ key: "revision", header: "修订", cell: (row) => `r${row.currentRevision}` },
				{
					key: "actions",
					header: "操作",
					className: "text-right whitespace-nowrap",
					cell: (row) => {
						const isAuthor = row.createdBy === viewer.actorId || row.ownerId === viewer.actorId;
						return (
							<>
								{row.status === "DRAFT" && canWrite && (
									<>
										<Button variant="ghost" size="sm" onClick={() => onEdit(row)}>
											编辑
										</Button>
										<Button variant="ghost" size="sm" onClick={() => onAction(row, "SUBMIT")}>
											提交审核
										</Button>
									</>
								)}
								{row.status === "IN_REVIEW" && canReview && !isAuthor && (
									<>
										<Button variant="ghost" size="sm" onClick={() => onAction(row, "APPROVE")}>
											通过
										</Button>
										<Button variant="ghost" size="sm" onClick={() => onAction(row, "REJECT")}>
											驳回
										</Button>
									</>
								)}
								{(row.status === "REJECTED" || row.status === "BASELINE" || row.status === "FROZEN") && canWrite && (
									<Button variant="ghost" size="sm" onClick={() => onAction(row, "REVISE")}>
										修订
									</Button>
								)}
								<Button variant="ghost" size="sm" onClick={() => onHistory(row)}>
									历史
								</Button>
							</>
						);
					},
				},
			]}
		/>
	);
}
