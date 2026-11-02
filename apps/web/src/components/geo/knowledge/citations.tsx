import { Link, useRouteContext } from "@tanstack/react-router";
import type { GeoPublicationScope } from "@workspace/geo-domain";
import { GeoFactApprovedBadge, GeoFactPendingBadge } from "@/components/geo/shell/evidence-badge";
import { GeoStatusBadge } from "@/components/geo/shell/status-badge";
import { useGeoViewer } from "@/components/geo/shell/use-geo-viewer";
import type { KnowledgeCitation } from "@/server/geo/knowledge-core";
import { ASSET_APPROVAL_LABELS, formatDate, formatDateTime, SCOPE_LABELS, SCOPE_TONES } from "./labels";

export function EvidenceClassBadge({ evidenceClass }: { evidenceClass: "APPROVED_FACT" | "UNREVIEWED" }) {
	return evidenceClass === "APPROVED_FACT" ? <GeoFactApprovedBadge /> : <GeoFactPendingBadge />;
}

export function ScopeBadge({ scope }: { scope: GeoPublicationScope }) {
	return <GeoStatusBadge label={SCOPE_LABELS[scope]} tone={SCOPE_TONES[scope]} />;
}

export function RiskBadge({ risk }: { risk: "HIGH" | "NORMAL" }) {
	return risk === "HIGH" ? <GeoStatusBadge label="高风险" tone="warning" /> : null;
}

type PageCitation = Extract<KnowledgeCitation, { kind: "PAGE_VERSION" }>;
type AssetCitation = Extract<KnowledgeCitation, { kind: "ASSET" }>;

function Quote({ text }: { text: string | null }) {
	if (!text) return null;
	return <blockquote className="border-l-2 pl-2 text-xs text-muted-foreground">{text}</blockquote>;
}

function PageCitationItem({ citation, compact }: { citation: PageCitation; compact: boolean }) {
	const { organization } = useRouteContext({ from: "/_authed/app/org/$org/geo" });
	const viewer = useGeoViewer();
	const snapshot =
		citation.pageVersionId && viewer.can("site.read_snapshot")
			? `/api/geo-snapshots/${citation.pageVersionId}?organizationId=${encodeURIComponent(organization.id)}`
			: null;
	return (
		<li className="flex flex-col gap-0.5">
			<div className="flex flex-wrap items-center gap-2">
				<GeoStatusBadge label="官网页面" tone="info" />
				{citation.pageStatus === "GONE" && <GeoStatusBadge label="页面已失效" tone="danger" />}
				{citation.pageId ? (
					<Link
						to="/app/org/$org/geo/site-pages/$id"
						params={{ org: organization.slug, id: citation.pageId }}
						className="break-all hover:underline"
					>
						{citation.url ?? "页面"}
					</Link>
				) : (
					<span className="break-all">{citation.url}</span>
				)}
			</div>
			{!compact && (
				<>
					<div className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
						<span>字段 {citation.fieldPath ?? "—"}</span>
						{citation.selector && <span>定位 {citation.selector}</span>}
						<span>解析版本 {citation.parserVersion ?? "—"}</span>
						<span>采集于 {formatDateTime(citation.extractedAt)}</span>
						{snapshot && (
							<a href={snapshot} className="underline">
								下载该版本原始快照
							</a>
						)}
					</div>
					<Quote text={citation.quote} />
				</>
			)}
		</li>
	);
}

function AssetCitationItem({ citation, compact }: { citation: AssetCitation; compact: boolean }) {
	const { organization } = useRouteContext({ from: "/_authed/app/org/$org/geo" });
	const showDetail = !compact && !citation.hidden;
	return (
		<li className="flex flex-col gap-0.5">
			<div className="flex flex-wrap items-center gap-2">
				<GeoStatusBadge label="客户原件" tone="success" />
				{citation.hidden || !citation.assetId ? (
					<span className="text-muted-foreground">保密资料（无权查看详情）</span>
				) : (
					<Link
						to="/app/org/$org/geo/knowledge/assets/$assetId"
						params={{ org: organization.slug, assetId: citation.assetId }}
						className="hover:underline"
					>
						{citation.assetTitle ?? "资料"}
					</Link>
				)}
				{citation.assetApproval && citation.assetApproval !== "APPROVED" && (
					<GeoStatusBadge label={ASSET_APPROVAL_LABELS[citation.assetApproval]} tone="warning" />
				)}
			</div>
			{showDetail && (
				<>
					<div className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
						{citation.page && <span>第 {citation.page} 页</span>}
						{citation.section && <span>章节 {citation.section}</span>}
						{citation.paragraph && <span>段落 {citation.paragraph}</span>}
						<span>资料有效期 {formatDate(citation.assetValidUntil)}</span>
					</div>
					<Quote text={citation.quote} />
				</>
			)}
		</li>
	);
}

/** One line per source: the page version and field for the website, the document and page for originals. */
export function CitationList({ citations, compact = false }: { citations: KnowledgeCitation[]; compact?: boolean }) {
	if (citations.length === 0) return <span className="text-sm text-muted-foreground">没有来源</span>;
	const shown = compact ? citations.slice(0, 2) : citations;
	return (
		<ul className="flex flex-col gap-2 text-sm">
			{shown.map((citation) =>
				citation.kind === "PAGE_VERSION" ? (
					<PageCitationItem key={citation.id} citation={citation} compact={compact} />
				) : (
					<AssetCitationItem key={citation.id} citation={citation} compact={compact} />
				),
			)}
			{compact && citations.length > shown.length && (
				<li className="text-xs text-muted-foreground">另有 {citations.length - shown.length} 个来源</li>
			)}
		</ul>
	);
}
