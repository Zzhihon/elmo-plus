import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GEO_PLATFORM_LABELS } from "@workspace/geo-domain";
import { Alert, AlertDescription } from "@workspace/ui/components/alert";
import { Badge } from "@workspace/ui/components/badge";
import { Button } from "@workspace/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@workspace/ui/components/card";
import { Checkbox } from "@workspace/ui/components/checkbox";
import { Skeleton } from "@workspace/ui/components/skeleton";
import { useState } from "react";
import { geoErrorMessage } from "@/components/geo/brands/format";
import { GeoEmptyState } from "@/components/geo/shell/empty-state";
import { useGeoViewer } from "@/components/geo/shell/use-geo-viewer";
import {
	acceptCompetitorCandidateFn,
	dismissCompetitorCandidateFn,
	listCompetitorsFn,
	startCompetitorDiscoveryFn,
} from "@/server/geo/competitors";
import type { GeoCompetitorCandidateView } from "@/server/geo/competitors-core";

function CandidateCard({
	candidate,
	canDecide,
	busy,
	onAccept,
	onDismiss,
}: {
	candidate: GeoCompetitorCandidateView;
	canDecide: boolean;
	busy: boolean;
	onAccept: () => void;
	onDismiss: () => void;
}) {
	const platforms = candidate.platforms.map((platform) => GEO_PLATFORM_LABELS[platform]).join("、");
	return (
		<Card>
			<CardHeader>
				<CardTitle className="text-base">{candidate.name}</CardTitle>
				<CardDescription>
					AI 回答中被提到 {candidate.mentionCount} 次，出现在 {candidate.observationCount} 条回答里
					{platforms && `（${platforms}）`}
				</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-3">
				{candidate.quotes.slice(0, 2).map((quote) => (
					<figure key={quote.observationId} className="rounded-md bg-muted/50 p-3 text-sm">
						<blockquote className="leading-relaxed">{quote.quote}</blockquote>
						<figcaption className="mt-1 text-xs text-muted-foreground">
							{GEO_PLATFORM_LABELS[quote.platform]} 回答“{quote.question}”
						</figcaption>
					</figure>
				))}
				{canDecide && (
					<div className="flex gap-2">
						<Button size="sm" onClick={onAccept} disabled={busy}>
							加入对比
						</Button>
						<Button size="sm" variant="outline" onClick={onDismiss} disabled={busy}>
							不是竞品
						</Button>
					</div>
				)}
			</CardContent>
		</Card>
	);
}

export function CompetitorsPanel({ organizationId }: { organizationId: string }) {
	const viewer = useGeoViewer();
	const canDecide = viewer.can("competitor.decide");
	const canDiscover = viewer.can("competitor.discover");
	const queryClient = useQueryClient();
	const queryKey = ["geo-competitors", organizationId];
	const competitorsQuery = useQuery({ queryKey, queryFn: () => listCompetitorsFn({ data: { organizationId } }) });
	const [askFirst, setAskFirst] = useState(false);
	const [notice, setNotice] = useState<string | null>(null);

	const refresh = () =>
		Promise.all([
			queryClient.invalidateQueries({ queryKey }),
			queryClient.invalidateQueries({ queryKey: ["geo-brands", organizationId] }),
		]);

	const discover = useMutation({
		mutationFn: () => startCompetitorDiscoveryFn({ data: { organizationId, sampleFirst: askFirst } }),
		onSuccess: (result) =>
			setNotice(
				!result.queued
					? "上一次分析还在进行中，完成后会自动出现在下方。"
					: result.sampledBatchId
						? "已开始向各 AI 平台提问，回答收齐后会自动分析，通常需要几十分钟。"
						: "已开始分析最近的 AI 回答，几分钟后刷新即可看到结果。",
			),
	});
	const decide = useMutation({
		mutationFn: async ({ id, accept }: { id: string; accept: boolean }) => {
			const data = { organizationId, candidateId: id };
			if (accept) await acceptCompetitorCandidateFn({ data });
			else await dismissCompetitorCandidateFn({ data });
		},
		onSuccess: refresh,
	});

	if (competitorsQuery.isPending) return <Skeleton className="h-96 w-full" />;
	if (competitorsQuery.isError || !competitorsQuery.data) {
		return (
			<Alert variant="destructive">
				<AlertDescription>{geoErrorMessage(competitorsQuery.error)}</AlertDescription>
			</Alert>
		);
	}
	const { competitors, candidates, dismissedCount, llmApproved } = competitorsQuery.data;
	const error = discover.error ?? decide.error;

	return (
		<div className="flex flex-col gap-6">
			<section className="flex flex-col gap-3">
				<h2 className="text-sm font-medium">正在对比的竞品</h2>
				{competitors.length === 0 ? (
					<p className="text-sm text-muted-foreground">还没有竞品。可以从下方 AI 发现的公司中挑选。</p>
				) : (
					<div className="flex flex-wrap gap-2">
						{competitors.map((competitor) => (
							<Badge key={competitor.id} variant="secondary" className="px-3 py-1 text-sm">
								{competitor.name}
							</Badge>
						))}
					</div>
				)}
			</section>

			<section className="flex flex-col gap-3">
				<div className="flex flex-wrap items-start justify-between gap-3">
					<div>
						<h2 className="text-sm font-medium">AI 回答中提到的其他公司</h2>
						<p className="text-sm text-muted-foreground">
							这些公司出现在 AI 平台回答采购问题时的推荐里，确认是竞品后即可加入对比。
							{dismissedCount > 0 && ` 已排除 ${dismissedCount} 家。`}
						</p>
					</div>
					{canDiscover && (
						<div className="flex flex-col items-end gap-2">
							<Button onClick={() => discover.mutate()} disabled={!llmApproved || discover.isPending}>
								{discover.isPending ? "正在开始…" : "从 AI 回答中发现竞品"}
							</Button>
							<label
								className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground"
								htmlFor="discover-ask-first"
							>
								<Checkbox
									id="discover-ask-first"
									checked={askFirst}
									onCheckedChange={(checked) => setAskFirst(checked === true)}
								/>
								先向各 AI 平台提问一轮再分析（耗时较长）
							</label>
						</div>
					)}
				</div>
				{canDiscover && !llmApproved && (
					<Alert>
						<AlertDescription>需要管理员先在设置中允许使用大模型，才能自动发现竞品。</AlertDescription>
					</Alert>
				)}
				{notice && (
					<Alert>
						<AlertDescription>{notice}</AlertDescription>
					</Alert>
				)}
				{error && (
					<Alert variant="destructive">
						<AlertDescription>{geoErrorMessage(error)}</AlertDescription>
					</Alert>
				)}
				{candidates.length === 0 ? (
					<GeoEmptyState
						title="暂时没有新发现的公司"
						description={
							canDiscover ? "点击“从 AI 回答中发现竞品”开始分析。" : "我们会定期分析 AI 回答，有新发现时会显示在这里。"
						}
					/>
				) : (
					<div className="grid gap-4 lg:grid-cols-2">
						{candidates.map((candidate) => (
							<CandidateCard
								key={candidate.id}
								candidate={candidate}
								canDecide={canDecide}
								busy={decide.isPending}
								onAccept={() => decide.mutate({ id: candidate.id, accept: true })}
								onDismiss={() => decide.mutate({ id: candidate.id, accept: false })}
							/>
						))}
					</div>
				)}
			</section>
		</div>
	);
}
