import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
	GEO_RECOMMENDATION_LABELS,
	GEO_REVIEW_REASON_LABELS,
	GEO_REVIEW_REASONS,
	type GeoReviewReason,
} from "@workspace/geo-domain";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@workspace/ui/components/select";
import { Skeleton } from "@workspace/ui/components/skeleton";
import { useState } from "react";
import { insightKeys } from "@/components/geo/insights/search";
import { formatDateTime } from "@/components/geo/sampling/format";
import { useGeoOrganization } from "@/components/geo/sampling/use-geo-organization";
import { GeoEmptyState } from "@/components/geo/shell/empty-state";
import { GeoPlatformBadge, GeoSurfaceModeBadge } from "@/components/geo/shell/evidence-badge";
import { GeoPaginatedTable, type GeoTableColumn } from "@/components/geo/shell/paginated-table";
import { GeoStatusBadge } from "@/components/geo/shell/status-badge";
import { listReviewPoolFn } from "@/server/geo/evaluation";
import type { ReviewPoolItem } from "@/server/geo/evaluation-core";

const ALL = "ALL";

function Reasons({ reasons }: { reasons: GeoReviewReason[] }) {
	return (
		<div className="flex flex-wrap gap-1">
			{reasons.map((reason) => (
				<GeoStatusBadge
					key={reason}
					label={GEO_REVIEW_REASON_LABELS[reason]}
					tone={reason === "CLAIM_MISMATCH" || reason === "LLM_DISAGREES" ? "danger" : "warning"}
				/>
			))}
		</div>
	);
}

/** Evaluations waiting for a reviewer, most important first; a review opens the evidence page. */
export function GeoReviewPool({
	page,
	onPageChange,
	limit,
}: {
	page: number;
	onPageChange: (page: number) => void;
	limit?: number;
}) {
	const organization = useGeoOrganization();
	const [reason, setReason] = useState<GeoReviewReason | undefined>();
	const filters = { reason };
	const pool = useQuery({
		queryKey: insightKeys.reviewPool(organization.id, filters, page),
		queryFn: () => listReviewPoolFn({ data: { organizationId: organization.id, page, limit: limit ?? 20, filters } }),
		placeholderData: keepPreviousData,
	});
	const columns: GeoTableColumn<ReviewPoolItem>[] = [
		{
			key: "priority",
			header: "优先级",
			cell: (row) => (
				<div className="flex flex-col">
					<span className="font-medium">{row.promptPriority}</span>
					<span className="text-xs tabular-nums text-muted-foreground">{row.reviewPriority}</span>
				</div>
			),
		},
		{
			key: "question",
			header: "问法",
			className: "max-w-md whitespace-normal",
			cell: (row) => (
				<Link
					to="/app/org/$org/geo/observations/$id"
					params={{ org: organization.slug, id: row.observationId }}
					className="hover:underline"
				>
					{row.questionText}
				</Link>
			),
		},
		{
			key: "source",
			header: "平台 / 方式",
			cell: (row) => (
				<div className="flex flex-col items-start gap-1">
					<GeoPlatformBadge platform={row.platform} />
					<GeoSurfaceModeBadge mode={row.surfaceMode} />
				</div>
			),
		},
		{
			key: "conclusion",
			header: "自动结论",
			cell: (row) => (
				<div className="flex flex-col">
					<span>{GEO_RECOMMENDATION_LABELS[row.recommendation]}</span>
					<span className="text-xs tabular-nums text-muted-foreground">
						置信度 {row.confidence === null ? "—" : row.confidence.toFixed(2)}
					</span>
				</div>
			),
		},
		{
			key: "reasons",
			header: "进入复核的原因",
			cell: (row) => (
				<div className="flex flex-col gap-1">
					<Reasons reasons={row.reviewReasons} />
					{row.pendingClaims > 0 && <span className="text-xs text-red-700">{row.pendingClaims} 条断言待技术审核</span>}
				</div>
			),
		},
		{
			key: "sampledAt",
			header: "采样时间",
			cell: (row) => <span className="text-xs">{formatDateTime(row.sampledAt)}</span>,
		},
	];

	return (
		<div className="flex flex-col gap-3">
			{!limit && (
				<Select
					items={{ [ALL]: "全部原因", ...GEO_REVIEW_REASON_LABELS }}
					value={reason ?? ALL}
					onValueChange={(next) => {
						setReason(next === ALL || next === null ? undefined : (next as GeoReviewReason));
						onPageChange(1);
					}}
				>
					<SelectTrigger className="w-56" aria-label="复核原因">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value={ALL}>全部原因</SelectItem>
						{GEO_REVIEW_REASONS.map((value) => (
							<SelectItem key={value} value={value}>
								{GEO_REVIEW_REASON_LABELS[value]}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			)}
			{pool.isLoading && <Skeleton className="h-40 w-full" />}
			{pool.error && <p className="text-sm text-destructive">{pool.error.message}</p>}
			{pool.data && (
				<GeoPaginatedTable
					columns={columns}
					rows={pool.data.rows}
					rowKey={(row) => row.evaluationId}
					page={pool.data.page}
					totalPages={pool.data.totalPages}
					total={pool.data.total}
					onPageChange={onPageChange}
					empty={<GeoEmptyState title="复核池为空" description="所有自动评估都已确认或无需人工复核。" />}
				/>
			)}
		</div>
	);
}
