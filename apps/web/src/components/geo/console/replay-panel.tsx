import { useQueries, useQuery } from "@tanstack/react-query";
import { GEO_PLATFORM_LABELS, type GeoPlatform } from "@workspace/geo-domain";
import { Badge } from "@workspace/ui/components/badge";
import { Button } from "@workspace/ui/components/button";
import { Card, CardContent } from "@workspace/ui/components/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@workspace/ui/components/select";
import { Skeleton } from "@workspace/ui/components/skeleton";
import { cn } from "@workspace/ui/lib/utils";
import { useMemo } from "react";
import { formatDateTime } from "@/components/geo/sampling/format";
import { GeoEmptyState } from "@/components/geo/shell/empty-state";
import { getReplayAnswerFn, listConsoleQuestionsFn, listReplaySamplesFn } from "@/server/geo/console";
import type { ConsoleQuestion, ConsoleSampleSummary } from "@/server/geo/console-core";
import { ChatTranscript, HighlightLegend } from "./chat-transcript";
import { channelLabel, consoleKeys } from "./labels";

export interface ReplaySelection {
	promptId?: string;
	observationId?: string;
	compare?: boolean;
}

function QuestionList({
	questions,
	selected,
	onSelect,
}: {
	questions: ConsoleQuestion[];
	selected: string | undefined;
	onSelect: (promptId: string) => void;
}) {
	return (
		<div className="flex max-h-[36rem] flex-col gap-1 overflow-y-auto pr-1">
			{questions.map((question) => (
				<button
					key={question.promptId}
					type="button"
					onClick={() => onSelect(question.promptId)}
					className={cn(
						"flex flex-col gap-1 rounded-md border px-3 py-2 text-left text-sm transition-colors hover:bg-muted/60",
						selected === question.promptId ? "border-primary bg-muted" : "border-transparent",
					)}
				>
					{question.buyerRoleTitle && <span className="text-xs text-muted-foreground">{question.buyerRoleTitle}</span>}
					<span className="line-clamp-2">{question.questionText}</span>
				</button>
			))}
		</div>
	);
}

/** Newest sample first, so the first one per platform is the latest. */
function byPlatform(samples: ConsoleSampleSummary[]): Map<GeoPlatform, ConsoleSampleSummary[]> {
	const grouped = new Map<GeoPlatform, ConsoleSampleSummary[]>();
	for (const sample of samples) grouped.set(sample.platform, [...(grouped.get(sample.platform) ?? []), sample]);
	return grouped;
}

function AnswerCard({ organizationId, observationId }: { organizationId: string; observationId: string }) {
	const answer = useQuery({
		queryKey: consoleKeys.answer(organizationId, observationId),
		queryFn: () => getReplayAnswerFn({ data: { organizationId, observationId } }),
	});
	if (answer.isLoading) return <Skeleton className="h-72 w-full" />;
	if (answer.error) return <GeoEmptyState title="这条回答打不开" description={answer.error.message} />;
	if (!answer.data) return null;
	return <ChatTranscript key={answer.data.id} answer={answer.data} />;
}

function CompareView({ organizationId, latest }: { organizationId: string; latest: ConsoleSampleSummary[] }) {
	const answers = useQueries({
		queries: latest.map((sample) => ({
			queryKey: consoleKeys.answer(organizationId, sample.id),
			queryFn: () => getReplayAnswerFn({ data: { organizationId, observationId: sample.id } }),
		})),
	});
	return (
		<div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
			{latest.map((sample, index) => {
				const query = answers[index];
				return (
					<Card key={sample.id}>
						<CardContent>
							{query?.data ? (
								<ChatTranscript key={query.data.id} answer={query.data} compact />
							) : query?.error ? (
								<p className="text-sm text-muted-foreground">{query.error.message}</p>
							) : (
								<Skeleton className="h-72 w-full" />
							)}
						</CardContent>
					</Card>
				);
			})}
		</div>
	);
}

function SampleSelect({
	samples,
	value,
	onChange,
}: {
	samples: ConsoleSampleSummary[];
	value: string;
	onChange: (observationId: string) => void;
}) {
	const label = (sample: ConsoleSampleSummary) =>
		`${formatDateTime(sample.sampledAt)} · ${channelLabel(sample.platform, sample.surfaceMode)}`;
	return (
		<Select
			items={Object.fromEntries(samples.map((sample) => [sample.id, label(sample)]))}
			value={value}
			onValueChange={(next) => onChange(String(next))}
		>
			<SelectTrigger className="w-full sm:w-80" aria-label="选择采样时间">
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				{samples.map((sample) => (
					<SelectItem key={sample.id} value={sample.id}>
						{label(sample)}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

function SampleViewer({
	organizationId,
	promptId,
	question,
	selection,
	onChange,
}: {
	organizationId: string;
	promptId: string;
	question: ConsoleQuestion | undefined;
	selection: ReplaySelection;
	onChange: (next: ReplaySelection) => void;
}) {
	const samples = useQuery({
		queryKey: consoleKeys.samples(organizationId, promptId),
		queryFn: () => listReplaySamplesFn({ data: { organizationId, promptId } }),
	});
	const grouped = useMemo(() => byPlatform(samples.data ?? []), [samples.data]);

	if (samples.isLoading) return <Skeleton className="h-96 w-full" />;
	if (samples.error) return <GeoEmptyState title="加载失败" description={samples.error.message} />;
	const all = samples.data ?? [];
	const current = all.find((sample) => sample.id === selection.observationId) ?? all[0];
	if (!current) {
		return (
			<GeoEmptyState
				title="这个问题还没有可回放的回答"
				description={
					question ? `“${question.questionText}”还没有成功采到的 AI 回答。可以切到“实时提问”现场问一次。` : undefined
				}
			/>
		);
	}
	const platformSamples = grouped.get(current.platform) ?? [];
	const latestPerPlatform = [...grouped.values()].flatMap((list) => list.slice(0, 1));

	return (
		<>
			<div className="flex flex-wrap items-center gap-2">
				{[...grouped.entries()].map(([platform, list]) => (
					<Button
						key={platform}
						size="sm"
						variant={!selection.compare && current.platform === platform ? "default" : "outline"}
						onClick={() => onChange({ promptId, observationId: list[0]?.id })}
					>
						{GEO_PLATFORM_LABELS[platform]}
						<Badge variant="secondary" className="ml-1">
							{list.length}
						</Badge>
					</Button>
				))}
				{grouped.size > 1 && (
					<Button
						size="sm"
						variant={selection.compare ? "default" : "outline"}
						onClick={() => onChange({ promptId, compare: !selection.compare })}
					>
						各平台并排对比
					</Button>
				)}
				<div className="ml-auto">
					<HighlightLegend />
				</div>
			</div>

			{selection.compare ? (
				<CompareView organizationId={organizationId} latest={latestPerPlatform} />
			) : (
				<Card>
					<CardContent className="flex flex-col gap-4">
						{platformSamples.length > 1 && (
							<SampleSelect
								samples={platformSamples}
								value={current.id}
								onChange={(observationId) => onChange({ promptId, observationId })}
							/>
						)}
						<AnswerCard organizationId={organizationId} observationId={current.id} />
					</CardContent>
				</Card>
			)}
		</>
	);
}

export function ReplayPanel({
	organizationId,
	selection,
	onChange,
}: {
	organizationId: string;
	selection: ReplaySelection;
	onChange: (next: ReplaySelection) => void;
}) {
	const questions = useQuery({
		queryKey: consoleKeys.questions(organizationId),
		queryFn: () => listConsoleQuestionsFn({ data: { organizationId } }),
	});
	const deepLinkId = selection.promptId ? undefined : selection.observationId;
	const deepLinked = useQuery({
		queryKey: consoleKeys.answer(organizationId, deepLinkId ?? ""),
		queryFn: () => getReplayAnswerFn({ data: { organizationId, observationId: deepLinkId ?? "" } }),
		enabled: Boolean(deepLinkId),
	});

	if (questions.isLoading || deepLinked.isLoading) return <Skeleton className="h-96 w-full" />;
	if (questions.error) return <GeoEmptyState title="加载失败" description={questions.error.message} />;
	const data = questions.data;
	if (!data?.set || data.questions.length === 0) {
		return (
			<GeoEmptyState
				title="还没有正在监测的问题"
				description="问题清单定稿后，这里会列出每个问题，并能回放 AI 平台当时的回答。"
			/>
		);
	}
	const promptId = selection.promptId ?? deepLinked.data?.promptId ?? data.questions[0]?.promptId;

	return (
		<div className="grid gap-6 lg:grid-cols-[18rem_1fr]">
			<div className="flex flex-col gap-2">
				<p className="text-xs text-muted-foreground">
					监测中的问题（{data.set.name} 第 {data.set.version} 版）
				</p>
				<QuestionList
					questions={data.questions}
					selected={promptId ?? undefined}
					onSelect={(next) => onChange({ promptId: next, compare: selection.compare })}
				/>
			</div>
			<div className="flex min-w-0 flex-col gap-4">
				{promptId && (
					<SampleViewer
						key={promptId}
						organizationId={organizationId}
						promptId={promptId}
						question={data.questions.find((question) => question.promptId === promptId)}
						selection={selection}
						onChange={onChange}
					/>
				)}
			</div>
		</div>
	);
}
