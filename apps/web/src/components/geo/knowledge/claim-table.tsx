import { Link, useRouteContext } from "@tanstack/react-router";
import { Alert, AlertDescription } from "@workspace/ui/components/alert";
import { Skeleton } from "@workspace/ui/components/skeleton";
import type { ReactNode } from "react";
import { GeoEmptyState } from "@/components/geo/shell/empty-state";
import { GeoPaginatedTable } from "@/components/geo/shell/paginated-table";
import { GeoAssertionStatusBadge, GeoStatusBadge } from "@/components/geo/shell/status-badge";
import type { KnowledgeClaimView } from "@/server/geo/knowledge-core";
import { CitationList, EvidenceClassBadge, RiskBadge, ScopeBadge } from "./citations";
import { claimTypeLabel, entityKindLabel, errorMessage, formatDate, valueText } from "./labels";

export interface ClaimPage {
	rows: KnowledgeClaimView[];
	total: number;
	totalPages: number;
}

export function ClaimTable({
	data,
	isLoading,
	error,
	page,
	onPageChange,
	empty,
}: {
	data: ClaimPage | undefined;
	isLoading: boolean;
	error: unknown;
	page: number;
	onPageChange: (page: number) => void;
	empty: ReactNode;
}) {
	const { organization } = useRouteContext({ from: "/_authed/app/org/$org/geo" });
	if (error) {
		return (
			<Alert variant="destructive">
				<AlertDescription>{errorMessage(error)}</AlertDescription>
			</Alert>
		);
	}
	if (isLoading && !data) return <Skeleton className="h-48 w-full" />;
	return (
		<GeoPaginatedTable<KnowledgeClaimView>
			rows={data?.rows ?? []}
			total={data?.total ?? 0}
			page={page}
			totalPages={data?.totalPages ?? 1}
			onPageChange={onPageChange}
			rowKey={(claim) => claim.id}
			empty={empty}
			columns={[
				{
					key: "claim",
					header: "主张",
					className: "min-w-72",
					cell: (claim) => (
						<div className="flex flex-col gap-1">
							<Link
								to="/app/org/$org/geo/knowledge/$id"
								params={{ org: organization.slug, id: claim.id }}
								className="line-clamp-2 font-medium hover:underline"
							>
								{claim.claimText}
							</Link>
							<span className="line-clamp-1 text-xs text-muted-foreground">
								{claim.fieldPath ?? "—"} = {valueText(claim.normalizedValue)}
							</span>
						</div>
					),
				},
				{
					key: "entity",
					header: "实体",
					cell: (claim) =>
						claim.entity ? (
							<span className="flex flex-col">
								<span>{claim.entity.title}</span>
								<span className="text-xs text-muted-foreground">{entityKindLabel(claim.entity.kind)}</span>
							</span>
						) : (
							"—"
						),
				},
				{
					key: "state",
					header: "审核",
					cell: (claim) => (
						<div className="flex flex-wrap gap-1">
							<EvidenceClassBadge evidenceClass={claim.evidenceClass} />
							<GeoAssertionStatusBadge status={claim.status} />
							<RiskBadge risk={claim.riskLevel} />
							{claim.frozen && <GeoStatusBadge label="已冻结" tone="danger" />}
							{claim.openConflicts > 0 && <GeoStatusBadge label="有冲突" tone="danger" />}
							{claim.expired && <GeoStatusBadge label="已过期" tone="danger" />}
						</div>
					),
				},
				{
					key: "type",
					header: "类型 / 范围",
					cell: (claim) => (
						<div className="flex flex-col items-start gap-1 text-sm">
							<span>{claimTypeLabel(claim.claimType)}</span>
							<ScopeBadge scope={claim.publicationScope} />
							<span className="text-xs text-muted-foreground">有效期 {formatDate(claim.validUntil)}</span>
						</div>
					),
				},
				{
					key: "sources",
					header: "来源",
					className: "min-w-64",
					cell: (claim) => <CitationList citations={claim.citations} compact />,
				},
			]}
		/>
	);
}

export function NoClaims({ title, description }: { title: string; description?: string }) {
	return <GeoEmptyState title={title} description={description} />;
}
