import { Link, useRouteContext } from "@tanstack/react-router";
import { GEO_FACT_BLOCKER_LABELS, GEO_TASK_STATE_LABELS } from "@workspace/geo-domain";
import { Alert, AlertDescription, AlertTitle } from "@workspace/ui/components/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@workspace/ui/components/card";
import type { ReactNode } from "react";
import { GeoEmptyState } from "@/components/geo/shell/empty-state";
import { GeoAssertionStatusBadge, GeoStatusBadge } from "@/components/geo/shell/status-badge";
import { CreateTaskFromEvidence } from "@/components/geo/tasks/create-task-from-evidence";
import type { KnowledgeClaimDetail } from "@/server/geo/knowledge-core";
import { CitationList, EvidenceClassBadge, RiskBadge, ScopeBadge } from "./citations";
import { AttachOriginalButton, ClaimReviewActions } from "./claim-actions";
import { ConflictCard } from "./conflicts";
import {
	claimTypeLabel,
	DECISION_LABELS,
	entityKindLabel,
	formatDate,
	formatDateTime,
	SCOPE_LABELS,
	valueText,
} from "./labels";

function Field({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="space-y-1">
			<dt className="text-xs text-muted-foreground">{label}</dt>
			<dd className="whitespace-pre-wrap break-words text-sm">{children ?? "—"}</dd>
		</div>
	);
}

function Section({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
	return (
		<Card>
			<CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
				<CardTitle className="text-base">{title}</CardTitle>
				{actions}
			</CardHeader>
			<CardContent>{children}</CardContent>
		</Card>
	);
}

function Summary({ detail }: { detail: KnowledgeClaimDetail }) {
	const { claim, gates } = detail;
	return (
		<Section title="主张" actions={<ClaimReviewActions detail={detail} />}>
			<div className="flex flex-col gap-4">
				<div className="flex flex-wrap gap-1">
					<EvidenceClassBadge evidenceClass={claim.evidenceClass} />
					<GeoAssertionStatusBadge status={claim.status} />
					<RiskBadge risk={claim.riskLevel} />
					<ScopeBadge scope={claim.publicationScope} />
					{claim.frozen && <GeoStatusBadge label="已冻结" tone="danger" />}
					{claim.expired && <GeoStatusBadge label="已过期，不可公开" tone="danger" />}
				</div>
				{claim.frozen && (
					<Alert variant="destructive">
						<AlertTitle>该事实已被冻结</AlertTitle>
						<AlertDescription>
							{claim.frozenByName} 于 {formatDateTime(claim.frozenAt)} 冻结：{claim.frozenReason}
						</AlertDescription>
					</Alert>
				)}
				{claim.status === "SOURCE_UNAVAILABLE" && (
					<Alert>
						<AlertTitle>{claim.expired ? "资料已过期，等待复核" : "来源不可用，等待复核"}</AlertTitle>
						<AlertDescription>该事实已从可公开知识中移除。补充新的来源后可重新提交审核，或标记失效。</AlertDescription>
					</Alert>
				)}
				<p className="text-base">{claim.claimText}</p>
				<dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
					<Field label="实体">
						{detail.entity ? `${entityKindLabel(detail.entity.kind)} · ${detail.entity.title}` : "—"}
					</Field>
					<Field label="字段">{claim.fieldPath ?? "—"}</Field>
					<Field label="规范化取值">{valueText(claim.normalizedValue)}</Field>
					<Field label="主张类型">{claimTypeLabel(claim.claimType)}</Field>
					<Field label="有效期至">{formatDate(claim.validUntil)}</Field>
					<Field label="录入人">{claim.authorName ?? "官网采集"}</Field>
					<Field label="高风险原件">
						{gates.effectiveRisk === "HIGH"
							? gates.hasOriginalDocument
								? "已关联有效原件"
								: "缺少有效原件"
							: "不要求"}
					</Field>
					<Field label="来源允许的最宽范围">{gates.widestScope ? SCOPE_LABELS[gates.widestScope] : "无有效来源"}</Field>
				</dl>
				{claim.publicBlockers.length > 0 && (
					<p className="text-xs text-muted-foreground">
						不能用于对外草稿的原因：{claim.publicBlockers.map((blocker) => GEO_FACT_BLOCKER_LABELS[blocker]).join("、")}
					</p>
				)}
			</div>
		</Section>
	);
}

function Siblings({ detail }: { detail: KnowledgeClaimDetail }) {
	const { organization } = useRouteContext({ from: "/_authed/app/org/$org/geo" });
	if (detail.siblings.length === 0) {
		return (
			<GeoEmptyState
				title="同一字段没有其他取值"
				description="来自官网多个页面和客户资料的相同取值会合并为一条主张。"
			/>
		);
	}
	return (
		<ul className="divide-y">
			{detail.siblings.map((sibling) => (
				<li key={sibling.id} className="flex flex-col gap-2 py-3">
					<div className="flex flex-wrap items-center gap-2 text-sm">
						<GeoAssertionStatusBadge status={sibling.status} />
						{!sibling.sameValue && <GeoStatusBadge label="取值不同" tone="warning" />}
						<Link
							to="/app/org/$org/geo/knowledge/$id"
							params={{ org: organization.slug, id: sibling.id }}
							className="font-medium hover:underline"
						>
							{valueText(sibling.normalizedValue)}
						</Link>
						<span className="text-xs text-muted-foreground">更新于 {formatDateTime(sibling.updatedAt)}</span>
					</div>
					<CitationList citations={sibling.citations} compact />
				</li>
			))}
		</ul>
	);
}

function Reviews({ detail }: { detail: KnowledgeClaimDetail }) {
	if (detail.reviews.length === 0) return <GeoEmptyState title="还没有审核记录" />;
	return (
		<ol className="divide-y">
			{detail.reviews.map((review) => (
				<li key={review.id} className="flex flex-col gap-1 py-3 text-sm">
					<div className="flex flex-wrap items-center gap-2">
						<span className="font-medium">{DECISION_LABELS[review.decision]}</span>
						<span className="text-muted-foreground">
							{review.reviewerName} · {formatDateTime(review.reviewedAt)}
						</span>
						{review.publicationScope && <ScopeBadge scope={review.publicationScope} />}
					</div>
					<p className="whitespace-pre-wrap">{review.basis}</p>
					<p className="text-xs text-muted-foreground">
						绑定来源：
						{review.sourceRef.length === 0 ? "无" : review.sourceRef.map(reviewSourceLabel).join("；")}
					</p>
				</li>
			))}
		</ol>
	);
}

type ReviewSource = KnowledgeClaimDetail["reviews"][number]["sourceRef"][number];

function reviewSourceLabel(source: ReviewSource): string {
	if (source.hidden) return "保密原件（无权查看）";
	if (source.kind === "PAGE_VERSION")
		return `页面版本 ${source.pageVersionId?.slice(0, 8) ?? "—"}（${source.url ?? ""}）`;
	const page = typeof source.locator.page === "number" ? ` 第 ${source.locator.page} 页` : "";
	return `客户原件 ${source.assetId?.slice(0, 8) ?? "—"}${page}`;
}

export function ClaimDetailView({ detail }: { detail: KnowledgeClaimDetail }) {
	const { organization } = useRouteContext({ from: "/_authed/app/org/$org/geo" });
	const { claim } = detail;
	return (
		<div className="flex flex-col gap-4">
			<Summary detail={detail} />
			<Section title="来源与原文定位" actions={<AttachOriginalButton detail={detail} />}>
				<CitationList citations={claim.citations} />
			</Section>
			{detail.conflicts.length > 0 && (
				<div className="flex flex-col gap-3">
					<h2 className="text-base font-semibold">冲突与新旧差异</h2>
					{detail.conflicts.map((conflict) => (
						<ConflictCard
							key={conflict.id}
							conflict={{
								id: conflict.id,
								status: conflict.status,
								resolution: conflict.resolution,
								createdAt: conflict.createdAt,
								candidate: conflict.candidate,
								approved: conflict.approved,
							}}
						/>
					))}
				</div>
			)}
			<Section title="同一字段的其他取值">
				<Siblings detail={detail} />
			</Section>
			<Section title="审核历史">
				<Reviews detail={detail} />
			</Section>
			<Section
				title="关联工单"
				actions={
					<CreateTaskFromEvidence
						sourceKind="ASSERTION"
						sourceRef={`assertion:${claim.id}`}
						evidence={{ assertionIds: [claim.id] }}
						defaultTitle={
							claim.publicationScope === "CONFIDENTIAL" ? "核对保密事实" : `核对事实：${claim.claimText}`.slice(0, 200)
						}
						defaultKind="FACT_CORRECTION"
						defaultRiskLevel={claim.riskLevel}
						size="sm"
						variant="outline"
					/>
				}
			>
				{detail.tasks.length === 0 ? (
					<GeoEmptyState title="没有关联工单" />
				) : (
					<ul className="flex flex-col gap-2 text-sm">
						{detail.tasks.map((task) => (
							<li key={task.id} className="flex items-center gap-2">
								<GeoStatusBadge label={GEO_TASK_STATE_LABELS[task.state]} />
								<Link
									to="/app/org/$org/geo/tasks/$id"
									params={{ org: organization.slug, id: task.id }}
									className="hover:underline"
								>
									{task.title}
								</Link>
							</li>
						))}
					</ul>
				)}
			</Section>
		</div>
	);
}
