import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
	GEO_CITATION_OWNER_LABELS,
	GEO_CLAIM_KIND_LABELS,
	GEO_CLAIM_VERDICT_LABELS,
	GEO_PLATFORM_LABELS,
	GEO_SURFACE_MODE_LABELS,
	type GeoClaimKind,
	type GeoClaimVerdict,
} from "@workspace/geo-domain";
import type { Insights } from "@workspace/geo-reports";
import { Card, CardContent, CardHeader, CardTitle } from "@workspace/ui/components/card";
import { Skeleton } from "@workspace/ui/components/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@workspace/ui/components/table";
import { formatDateTime } from "@/components/geo/sampling/format";
import { useGeoOrganization } from "@/components/geo/sampling/use-geo-organization";
import { GeoEmptyState } from "@/components/geo/shell/empty-state";
import { GeoPlatformBadge, GeoSurfaceModeBadge } from "@/components/geo/shell/evidence-badge";
import { GeoStatusBadge } from "@/components/geo/shell/status-badge";
import { CreateTaskFromEvidence } from "@/components/geo/tasks/create-task-from-evidence";
import { listClaimIssuesFn } from "@/server/geo/metrics";
import type { MetricQuery } from "@/server/geo/metrics-core";
import { type EvidenceFilter, EvidenceLink, MetricFigure } from "./metric-figure";
import { insightKeys } from "./search";

function CellHeading({ platform, surfaceMode }: Pick<Insights["cells"][number], "platform" | "surfaceMode">) {
	return (
		<CardTitle className="flex flex-wrap items-center gap-2 text-sm font-medium">
			<GeoPlatformBadge platform={platform} />
			<GeoSurfaceModeBadge mode={surfaceMode} />
		</CardTitle>
	);
}

/** Brand against each competitor on the same valid samples, per platform and surface mode. */
export function GeoCompetitorComparison({
	insights,
	filter,
}: {
	insights: Insights;
	filter: Omit<EvidenceFilter, "platform" | "surfaceMode">;
}) {
	if (insights.cells.length === 0) return <GeoEmptyState title="当前条件下没有样本" />;
	return (
		<div className="flex flex-col gap-4">
			<p className="text-sm text-muted-foreground">
				各竞品在同一组有效样本中分别计算，可同时出现，占比合计可超过 100%。
			</p>
			{insights.cells.map((cell) => (
				<Card key={`${cell.platform}-${cell.surfaceMode}`}>
					<CardHeader className="pb-2">
						<CellHeading platform={cell.platform} surfaceMode={cell.surfaceMode} />
					</CardHeader>
					<CardContent>
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>品牌</TableHead>
									<TableHead>提及率</TableHead>
									<TableHead>推荐率</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								<TableRow>
									<TableCell className="font-medium">本品牌</TableCell>
									<TableCell>
										<EvidenceLink filter={{ ...filter, platform: cell.platform, surfaceMode: cell.surfaceMode }}>
											<MetricFigure value={cell.mentionRate} />
										</EvidenceLink>
									</TableCell>
									<TableCell>
										<MetricFigure value={cell.recommendationRate} />
									</TableCell>
								</TableRow>
								{cell.competitors.map((competitor) => (
									<TableRow key={competitor.entityId}>
										<TableCell>{competitor.name}</TableCell>
										<TableCell>
											<MetricFigure value={competitor.mentioned} />
										</TableCell>
										<TableCell>
											<MetricFigure value={competitor.recommended} />
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					</CardContent>
				</Card>
			))}
		</div>
	);
}

const OWNER_TONE = { OWN: "success", COMPETITOR: "warning", THIRD_PARTY: "neutral" } as const;

/** Cited domains after URL normalisation, labelled own, competitor or third party; "不提供" when nothing was cited. */
export function GeoCitationSources({ insights }: { insights: Insights }) {
	if (insights.cells.length === 0) return <GeoEmptyState title="当前条件下没有样本" />;
	return (
		<div className="grid gap-4 lg:grid-cols-2">
			{insights.cells.map((cell) => (
				<Card key={`${cell.platform}-${cell.surfaceMode}`}>
					<CardHeader className="gap-1 pb-2">
						<CellHeading platform={cell.platform} surfaceMode={cell.surfaceMode} />
						<div className="text-xs text-muted-foreground">
							带引用的回答：
							<MetricFigure
								value={cell.citations.samplesWithCitations}
								notProvided={cell.citations.status === "NOT_PROVIDED"}
							/>
						</div>
					</CardHeader>
					<CardContent>
						{cell.citations.status === "NOT_PROVIDED" ? (
							<p className="text-sm text-muted-foreground">不提供：该条件下的回答没有给出引用链接。</p>
						) : (
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>域名</TableHead>
										<TableHead>归属</TableHead>
										<TableHead className="text-right">引用次数</TableHead>
										<TableHead className="text-right">样本数</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{cell.citations.domains.slice(0, 15).map((domain) => (
										<TableRow key={domain.host}>
											<TableCell className="font-mono text-xs">{domain.host}</TableCell>
											<TableCell>
												<GeoStatusBadge
													label={GEO_CITATION_OWNER_LABELS[domain.owner]}
													tone={OWNER_TONE[domain.owner]}
												/>
											</TableCell>
											<TableCell className="text-right tabular-nums">{domain.count}</TableCell>
											<TableCell className="text-right tabular-nums">{domain.samples}</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>
						)}
					</CardContent>
				</Card>
			))}
		</div>
	);
}

/** Confirmed errors first, then statements that disagree with approved knowledge and wait for technical review. */
export function GeoErrorList({ query }: { query: MetricQuery }) {
	const organization = useGeoOrganization();
	const issues = useQuery({
		queryKey: insightKeys.claims(organization.id, query),
		queryFn: () => listClaimIssuesFn({ data: { organizationId: organization.id, query } }),
	});
	if (issues.isLoading) return <Skeleton className="h-48 w-full" />;
	if (issues.error) return <p className="text-sm text-destructive">{issues.error.message}</p>;
	const rows = issues.data ?? [];
	if (rows.length === 0) {
		return (
			<GeoEmptyState
				title="没有错误描述"
				description="当前条件下没有经技术审核确认的错误，也没有与已审核知识不一致的待审陈述。无法核实的陈述不会列为错误。"
			/>
		);
	}
	return (
		<div className="rounded-lg border">
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead>状态</TableHead>
						<TableHead>类型</TableHead>
						<TableHead className="min-w-72">回答中的陈述</TableHead>
						<TableHead>回答值 / 已审核值</TableHead>
						<TableHead>平台</TableHead>
						<TableHead>采样时间</TableHead>
						<TableHead className="text-right">操作</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{rows.map((row) => (
						<TableRow key={row.claimId}>
							<TableCell>
								<GeoStatusBadge
									label={row.verdict === "ERROR" ? GEO_CLAIM_VERDICT_LABELS.ERROR : "待技术审核"}
									tone={row.verdict === "ERROR" ? "danger" : "warning"}
								/>
							</TableCell>
							<TableCell>{GEO_CLAIM_KIND_LABELS[row.claimKind as GeoClaimKind] ?? row.claimKind}</TableCell>
							<TableCell className="max-w-md whitespace-normal text-sm">
								<Link
									to="/app/org/$org/geo/observations/$id"
									params={{ org: organization.slug, id: row.observationId }}
									className="hover:underline"
								>
									{row.claimText}
								</Link>
								{row.reviewNote && <div className="text-xs text-muted-foreground">审核意见：{row.reviewNote}</div>}
							</TableCell>
							<TableCell className="font-mono text-xs">
								{row.extractedValue ?? "—"} / {row.referenceValue ?? "—"}
							</TableCell>
							<TableCell className="whitespace-nowrap text-sm">
								{GEO_PLATFORM_LABELS[row.platform]} · {GEO_SURFACE_MODE_LABELS[row.surfaceMode]}
							</TableCell>
							<TableCell className="whitespace-nowrap text-xs">{formatDateTime(row.sampledAt)}</TableCell>
							<TableCell className="text-right">
								{(row.verdict as GeoClaimVerdict) === "ERROR" && (
									<CreateTaskFromEvidence
										sourceKind="OBSERVATION"
										sourceRef={`claim:${row.claimId}`}
										evidence={{ observationIds: [row.observationId] }}
										defaultTitle={`纠正错误描述：${row.extractedValue ?? row.claimText}`.slice(0, 120)}
										defaultKind="FACT_CORRECTION"
										defaultRiskLevel="HIGH"
										recommendedAction={`AI 回答称“${row.claimText.slice(0, 200)}”，经技术审核确认与已审核事实不符（已审核值：${row.referenceValue ?? "见审核意见"}）。在官网与对外资料中补充可核实的正确表述后复测。`}
										label="创建工单"
										size="sm"
										variant="outline"
									/>
								)}
							</TableCell>
						</TableRow>
					))}
				</TableBody>
			</Table>
		</div>
	);
}
