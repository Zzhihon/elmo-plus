import { IconInfoCircle } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, AlertDescription } from "@workspace/ui/components/alert";
import { Button } from "@workspace/ui/components/button";
import { Card, CardContent } from "@workspace/ui/components/card";
import { Checkbox } from "@workspace/ui/components/checkbox";
import { Label } from "@workspace/ui/components/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@workspace/ui/components/select";
import { Skeleton } from "@workspace/ui/components/skeleton";
import { Spinner } from "@workspace/ui/components/spinner";
import { Textarea } from "@workspace/ui/components/textarea";
import { useState } from "react";
import { formatDateTime, formatDuration } from "@/components/geo/sampling/format";
import { GeoEmptyState } from "@/components/geo/shell/empty-state";
import { askLiveQuestionFn, getLiveSetupFn, listConsoleQuestionsFn, listRecentLiveRunsFn } from "@/server/geo/console";
import type { LiveQuota, LiveRunView, LiveTargetOption } from "@/server/geo/console-live-core";
import { ChatTranscript, HighlightLegend } from "./chat-transcript";
import { channelLabel, consoleKeys } from "./labels";

const MAX_PLATFORMS = 4;
const MIN_QUESTION_LENGTH = 4;

function RunResult({ run, animate }: { run: LiveRunView; animate: boolean }) {
	if (run.answer) {
		return (
			<Card>
				<CardContent>
					<ChatTranscript key={run.id} answer={run.answer} animate={animate} compact />
				</CardContent>
			</Card>
		);
	}
	return (
		<Card>
			<CardContent className="flex flex-col gap-2 text-sm">
				<span className="font-medium">{channelLabel(run.platform, run.surfaceMode)}</span>
				<p className="text-muted-foreground">
					{run.status === "RUNNING" ? "这次提问没有完成。" : (run.errorMessage ?? "这次没有拿到回答，请稍后再试。")}
				</p>
			</CardContent>
		</Card>
	);
}

function MonitoredQuestionPicker({
	organizationId,
	onPick,
}: {
	organizationId: string;
	onPick: (question: string) => void;
}) {
	const questions = useQuery({
		queryKey: consoleKeys.questions(organizationId),
		queryFn: () => listConsoleQuestionsFn({ data: { organizationId } }),
	});
	const items = Object.fromEntries((questions.data?.questions ?? []).map((item) => [item.promptId, item.questionText]));
	if (Object.keys(items).length === 0) return null;
	return (
		<Select items={items} value={null} onValueChange={(next) => next && onPick(items[String(next)] ?? "")}>
			<SelectTrigger size="sm" className="w-64" aria-label="从监测问题中选">
				<SelectValue placeholder="从监测问题中选一个" />
			</SelectTrigger>
			<SelectContent>
				{Object.entries(items).map(([id, text]) => (
					<SelectItem key={id} value={id}>
						{text}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

function TargetPicker({
	targets,
	chosen,
	disabled,
	onToggle,
}: {
	targets: LiveTargetOption[];
	chosen: string[];
	disabled: boolean;
	onToggle: (targetId: string, on: boolean) => void;
}) {
	return (
		<div className="flex flex-col gap-2">
			<Label>问哪些平台</Label>
			{targets.map((target) => (
				<div key={target.id} className="flex items-start gap-2">
					<Checkbox
						id={`live-target-${target.id}`}
						checked={chosen.includes(target.id)}
						disabled={Boolean(target.unavailableReason) || disabled}
						onCheckedChange={(checked) => onToggle(target.id, Boolean(checked))}
					/>
					<label htmlFor={`live-target-${target.id}`} className="flex flex-col text-sm leading-tight">
						<span>
							{channelLabel(target.platform, target.surfaceMode)}
							{target.modelId && <span className="ml-1 text-xs text-muted-foreground">{target.modelId}</span>}
						</span>
						{target.unavailableReason && (
							<span className="text-xs text-muted-foreground">{target.unavailableReason}</span>
						)}
					</label>
				</div>
			))}
			{targets.every((target) => target.unavailableReason) && (
				<p className="text-xs text-muted-foreground">现在没有可以提问的平台，请稍后再来或联系管理员。</p>
			)}
		</div>
	);
}

function AskForm({
	organizationId,
	targets,
	quota,
	canAsk,
	onAnswered,
}: {
	organizationId: string;
	targets: LiveTargetOption[];
	quota: LiveQuota;
	canAsk: boolean;
	onAnswered: (runs: LiveRunView[]) => void;
}) {
	const queryClient = useQueryClient();
	const [question, setQuestion] = useState("");
	const [chosen, setChosen] = useState<string[]>([]);
	const ask = useMutation({
		mutationFn: () =>
			askLiveQuestionFn({ data: { organizationId, input: { question: question.trim(), targetIds: chosen } } }),
		onSuccess: async (result) => {
			onAnswered(result.runs);
			await queryClient.invalidateQueries({ queryKey: consoleKeys.live(organizationId) });
		},
	});
	const allowed = Math.min(quota.remaining, MAX_PLATFORMS);
	const tooMany = chosen.length > allowed;
	const canSubmit =
		canAsk && question.trim().length >= MIN_QUESTION_LENGTH && chosen.length > 0 && !tooMany && !ask.isPending;

	return (
		<Card>
			<CardContent className="flex flex-col gap-5">
				<div className="flex flex-col gap-2">
					<div className="flex flex-wrap items-center justify-between gap-2">
						<Label htmlFor="live-question">想问 AI 什么</Label>
						<MonitoredQuestionPicker organizationId={organizationId} onPick={setQuestion} />
					</div>
					<Textarea
						id="live-question"
						value={question}
						maxLength={500}
						rows={3}
						placeholder="例如：广州有哪些靠谱的高低压开关柜厂家？"
						onChange={(event) => setQuestion(event.target.value)}
					/>
				</div>

				<TargetPicker
					targets={targets}
					chosen={chosen}
					disabled={!canAsk}
					onToggle={(targetId, on) =>
						setChosen((current) => (on ? [...current, targetId] : current.filter((id) => id !== targetId)))
					}
				/>

				<div className="flex flex-wrap items-center gap-3">
					<Button onClick={() => ask.mutate()} disabled={!canSubmit}>
						{ask.isPending && <Spinner />}
						{ask.isPending ? "正在等 AI 回答" : "提问"}
					</Button>
					<span className="text-sm text-muted-foreground">
						今天还能问 {quota.remaining} 次（每个平台算一次；团队每天 {quota.orgLimit} 次，每人每天 {quota.userLimit}{" "}
						次）
					</span>
				</div>
				{!canAsk && <p className="text-sm text-muted-foreground">你的账号没有实时提问的权限。</p>}
				{tooMany && (
					<p className="text-sm text-muted-foreground">选的平台比剩余次数多，这次最多选 {allowed} 个平台。</p>
				)}
				{ask.isPending && (
					<p className="text-sm text-muted-foreground">AI 平台通常需要 10 到 60 秒才能答完，请不要关闭页面。</p>
				)}
				{ask.error && (
					<Alert variant="destructive">
						<AlertDescription>{ask.error.message}</AlertDescription>
					</Alert>
				)}
			</CardContent>
		</Card>
	);
}

function recentStatus(run: LiveRunView): string {
	if (run.status === "SUCCEEDED") return `用时 ${formatDuration(run.latencyMs)}`;
	return run.status === "RUNNING" ? "进行中" : "未拿到回答";
}

function RecentRuns({ organizationId }: { organizationId: string }) {
	const [openedRun, setOpenedRun] = useState<string | null>(null);
	const recent = useQuery({
		queryKey: [...consoleKeys.live(organizationId), "recent"],
		queryFn: () => listRecentLiveRunsFn({ data: { organizationId } }),
	});
	const runs = recent.data ?? [];
	if (runs.length === 0) return null;
	const opened = runs.find((run) => run.id === openedRun);
	return (
		<div className="flex flex-col gap-3">
			<h3 className="text-sm font-medium">我最近的实时提问</h3>
			<div className="flex flex-col divide-y rounded-md border">
				{runs.map((run) => (
					<button
						key={run.id}
						type="button"
						onClick={() => setOpenedRun(openedRun === run.id ? null : run.id)}
						className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-left text-sm hover:bg-muted/60"
					>
						<span className="min-w-0 flex-1 truncate">{run.question}</span>
						<span className="text-xs text-muted-foreground">{channelLabel(run.platform, run.surfaceMode)}</span>
						<span className="text-xs text-muted-foreground">{recentStatus(run)}</span>
						<span className="text-xs text-muted-foreground">{formatDateTime(run.createdAt)}</span>
					</button>
				))}
			</div>
			{opened && <RunResult run={opened} animate={false} />}
		</div>
	);
}

export function LivePanel({ organizationId, canAsk }: { organizationId: string; canAsk: boolean }) {
	const [latest, setLatest] = useState<LiveRunView[]>([]);
	const setup = useQuery({
		queryKey: [...consoleKeys.live(organizationId), "setup"],
		queryFn: () => getLiveSetupFn({ data: { organizationId } }),
	});

	if (setup.isLoading) return <Skeleton className="h-96 w-full" />;
	if (setup.error) return <GeoEmptyState title="加载失败" description={setup.error.message} />;
	if (!setup.data) return null;

	return (
		<div className="flex flex-col gap-6">
			<Alert>
				<IconInfoCircle />
				<AlertDescription>
					实时提问结果只用于演示，不计入曝光率。每次提问会真实调用所选平台，所以每天的次数有限。
				</AlertDescription>
			</Alert>

			{setup.data.targets.length === 0 ? (
				<GeoEmptyState
					title="还没有可以实时提问的平台"
					description="管理员在“采样”里接入并验证 AI 平台后，就可以在这里现场提问。"
				/>
			) : (
				<AskForm
					organizationId={organizationId}
					targets={setup.data.targets}
					quota={setup.data.quota}
					canAsk={canAsk}
					onAnswered={setLatest}
				/>
			)}

			{latest.length > 0 && (
				<div className="flex flex-col gap-3">
					<div className="flex items-center justify-between gap-2">
						<h3 className="text-sm font-medium">刚才的回答</h3>
						<HighlightLegend />
					</div>
					<div className="grid gap-4 lg:grid-cols-2">
						{latest.map((run) => (
							<RunResult key={run.id} run={run} animate />
						))}
					</div>
				</div>
			)}

			<RecentRuns organizationId={organizationId} />
		</div>
	);
}
