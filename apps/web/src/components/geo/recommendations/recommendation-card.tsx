import { IconChevronDown, IconExternalLink } from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { GEO_PLATFORM_LABELS, GEO_SURFACE_MODE_LABELS } from "@workspace/geo-domain";
import { GEO_CITED_CONTENT_TYPE_LABELS } from "@workspace/geo-reports/recommendations/labels";
import { Button } from "@workspace/ui/components/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@workspace/ui/components/collapsible";
import type { ReactNode } from "react";
import { useGeoViewer } from "@/components/geo/shell/use-geo-viewer";
import { errorMessage } from "@/components/geo/site-pages/site-labels";
import {
	convertRecommendationFn,
	dismissRecommendationFn,
	restoreRecommendationFn,
} from "@/server/geo/recommendations";
import type { RecommendationItem } from "@/server/geo/recommendations-core";
import { RecommendationPriorityBadge, recommendationKeys } from "./labels";

const SAMPLE_LINKS = 6;

function ExternalLink({ url, label }: { url: string; label?: string | null }) {
	return (
		<a
			href={url}
			target="_blank"
			rel="noopener noreferrer"
			className="inline-flex max-w-full items-center gap-1 truncate text-primary underline-offset-2 hover:underline"
		>
			<span className="truncate">{label || url}</span>
			<IconExternalLink className="size-3 shrink-0" />
		</a>
	);
}

function EvidenceBlock({ title, children }: { title: string; children: ReactNode }) {
	return (
		<div className="flex flex-col gap-1.5">
			<p className="text-xs font-medium text-muted-foreground">{title}</p>
			{children}
		</div>
	);
}

function Evidence({ item, orgSlug }: { item: RecommendationItem; orgSlug: string }) {
	const evidence = item.evidence;
	const competitorName = new Map((evidence.competitors ?? []).map((entry) => [entry.entityId, entry.name]));
	const sampleIds = (evidence.observationIds ?? []).slice(0, SAMPLE_LINKS);
	return (
		<div className="flex flex-col gap-4 rounded-md bg-muted/40 p-4 text-sm">
			{evidence.lostQuestions && evidence.lostQuestions.length > 0 && (
				<EvidenceBlock title="没有提到我们的问题">
					<ul className="flex flex-col gap-1.5">
						{evidence.lostQuestions.slice(0, 20).map((question) => (
							<li key={`${question.promptId}-${question.platform}-${question.surfaceMode}`}>
								<span>{question.questionText}</span>
								<span className="text-muted-foreground">
									{" · "}
									{GEO_PLATFORM_LABELS[question.platform]}（{GEO_SURFACE_MODE_LABELS[question.surfaceMode]}）
									{question.buyerRole ? ` · ${question.buyerRole}` : ""}
									{question.competitorIds.length > 0
										? ` · 提到了${question.competitorIds.map((id) => competitorName.get(id) ?? "竞品").join("、")}`
										: ""}
								</span>
							</li>
						))}
					</ul>
				</EvidenceBlock>
			)}
			{evidence.citedPages && evidence.citedPages.length > 0 && (
				<EvidenceBlock title="AI 引用的网页">
					<ul className="flex flex-col gap-1">
						{evidence.citedPages.map((page) => (
							<li key={page.url} className="flex min-w-0 items-center gap-2">
								<span className="shrink-0 text-xs text-muted-foreground">
									{GEO_CITED_CONTENT_TYPE_LABELS[page.contentType]}
								</span>
								<ExternalLink url={page.url} label={page.title} />
							</li>
						))}
					</ul>
				</EvidenceBlock>
			)}
			{evidence.siteHas && (
				<EvidenceBlock title="官网现有内容">
					{evidence.siteHas.count === 0 ? (
						<p className="text-muted-foreground">没有找到相关页面。</p>
					) : (
						<ul className="flex flex-col gap-1">
							{evidence.siteHas.examples.map((example) => (
								<li key={`${example.title}-${example.url}`}>
									{example.url ? <ExternalLink url={example.url} label={example.title} /> : example.title}
								</li>
							))}
						</ul>
					)}
				</EvidenceBlock>
			)}
			{evidence.pages && evidence.pages.length > 0 && (
				<EvidenceBlock title="涉及的页面">
					<ul className="flex flex-col gap-1">
						{evidence.pages.map((page) =>
							page.url ? (
								<li key={page.url}>
									<ExternalLink url={page.url} />
								</li>
							) : (
								<li key="site" className="text-muted-foreground">
									整个网站
								</li>
							),
						)}
					</ul>
				</EvidenceBlock>
			)}
			{evidence.claims && evidence.claims.length > 0 && (
				<EvidenceBlock title="AI 的原话">
					<ul className="flex flex-col gap-1">
						{evidence.claims.map((claim) => (
							<li key={claim.id}>“{claim.claimText}”</li>
						))}
					</ul>
				</EvidenceBlock>
			)}
			{sampleIds.length > 0 && (
				<EvidenceBlock title="查看 AI 回答原文">
					<div className="flex flex-wrap gap-2">
						{sampleIds.map((observationId, index) => (
							<Link
								key={observationId}
								to="/app/org/$org/geo/console"
								params={{ org: orgSlug }}
								search={{ observationId }}
								className="rounded-md border bg-background px-2 py-1 text-xs hover:bg-muted"
							>
								回答 {index + 1}
							</Link>
						))}
					</div>
				</EvidenceBlock>
			)}
		</div>
	);
}

function Actions({
	item,
	organizationId,
	orgSlug,
}: {
	item: RecommendationItem;
	organizationId: string;
	orgSlug: string;
}) {
	const viewer = useGeoViewer();
	const queryClient = useQueryClient();
	const invalidate = () => queryClient.invalidateQueries({ queryKey: recommendationKeys.all(organizationId) });
	const input = { organizationId, input: { recommendationId: item.id } };
	const convert = useMutation({ mutationFn: () => convertRecommendationFn({ data: input }), onSuccess: invalidate });
	const dismiss = useMutation({ mutationFn: () => dismissRecommendationFn({ data: input }), onSuccess: invalidate });
	const restore = useMutation({ mutationFn: () => restoreRecommendationFn({ data: input }), onSuccess: invalidate });
	const error = convert.error ?? dismiss.error ?? restore.error;
	const busy = convert.isPending || dismiss.isPending || restore.isPending;

	if (item.status === "CONVERTED" && item.taskId) {
		return (
			<Link
				to="/app/org/$org/geo/tasks/$id"
				params={{ org: orgSlug, id: item.taskId }}
				className="text-sm text-primary underline-offset-2 hover:underline"
			>
				已转工单{item.taskTitle ? `：${item.taskTitle}` : ""}
			</Link>
		);
	}
	if (!viewer.can("recommendation.triage")) return null;
	return (
		<div className="flex flex-wrap items-center gap-2">
			{item.status === "OPEN" && viewer.can("task.create") && (
				<Button size="sm" onClick={() => convert.mutate()} disabled={busy}>
					转为工单
				</Button>
			)}
			{item.status === "OPEN" && (
				<Button size="sm" variant="ghost" onClick={() => dismiss.mutate()} disabled={busy}>
					忽略
				</Button>
			)}
			{item.status === "DISMISSED" && (
				<Button size="sm" variant="outline" onClick={() => restore.mutate()} disabled={busy}>
					恢复
				</Button>
			)}
			{error && <span className="text-xs text-destructive">{errorMessage(error)}</span>}
		</div>
	);
}

export function RecommendationCard({
	item,
	organizationId,
	orgSlug,
}: {
	item: RecommendationItem;
	organizationId: string;
	orgSlug: string;
}) {
	return (
		<div className="flex flex-col gap-3 rounded-lg border bg-background p-4">
			<div className="flex flex-wrap items-start justify-between gap-2">
				<div className="flex min-w-0 flex-1 flex-col gap-1">
					<div className="flex flex-wrap items-center gap-2">
						<RecommendationPriorityBadge priority={item.priority} />
						{item.status === "DISMISSED" && <span className="text-xs text-muted-foreground">已忽略</span>}
						<p className="font-medium">{item.title}</p>
					</div>
					<p className="text-sm text-muted-foreground">{item.summary}</p>
				</div>
				<Actions item={item} organizationId={organizationId} orgSlug={orgSlug} />
			</div>
			{item.evidence.action && <p className="text-sm">{item.evidence.action}</p>}
			<Collapsible>
				<CollapsibleTrigger className="group inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
					<IconChevronDown className="size-4 transition-transform group-data-[panel-open]:rotate-180" />
					查看依据
				</CollapsibleTrigger>
				<CollapsibleContent className="pt-3">
					<Evidence item={item} orgSlug={orgSlug} />
				</CollapsibleContent>
			</Collapsible>
		</div>
	);
}
