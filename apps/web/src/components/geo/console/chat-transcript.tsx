import { IconExternalLink, IconRobot, IconUser } from "@tabler/icons-react";
import type { AnswerSegment } from "@workspace/geo-reports/evaluation";
import { Badge } from "@workspace/ui/components/badge";
import { Button } from "@workspace/ui/components/button";
import { cn } from "@workspace/ui/lib/utils";
import { formatDateTime } from "@/components/geo/sampling/format";
import { ResponseMarkdown } from "@/components/response-markdown";
import type { ConsoleAnswer, ConsoleCitation } from "@/server/geo/console-core";
import { channelLabel, outcomeParts } from "./labels";
import { useTypewriter } from "./use-typewriter";

const MARK_CLASS = {
	OWN: "rounded-sm bg-emerald-100 px-0.5 font-medium text-emerald-900",
	COMPETITOR: "rounded-sm bg-orange-100 px-0.5 font-medium text-orange-900",
} as const;

function AnswerText({ text, segments, shown }: { text: string; segments: AnswerSegment[]; shown: number }) {
	const markRanges = segments.flatMap((segment) =>
		segment.kind && segment.start < shown
			? [{ start: segment.start, end: Math.min(segment.end, shown), className: MARK_CLASS[segment.kind] }]
			: [],
	);
	return <ResponseMarkdown markRanges={markRanges}>{text.slice(0, shown)}</ResponseMarkdown>;
}

export function HighlightLegend() {
	return (
		<div className="flex items-center gap-3 text-xs text-muted-foreground">
			<span className="flex items-center gap-1">
				<span className="size-2.5 rounded-sm bg-emerald-200" />
				你的品牌
			</span>
			<span className="flex items-center gap-1">
				<span className="size-2.5 rounded-sm bg-orange-200" />
				竞品
			</span>
		</div>
	);
}

function OutcomeStrip({ answer }: { answer: ConsoleAnswer }) {
	const brandName = answer.ownBrandName ?? "你的品牌";
	const parts = outcomeParts(answer.outcome, brandName);
	const tone = !answer.outcome.brandMentioned
		? "border-muted bg-muted/50 text-muted-foreground"
		: answer.outcome.recommendation === "NEGATIVE"
			? "border-red-200 bg-red-50 text-red-900"
			: "border-emerald-200 bg-emerald-50 text-emerald-900";
	return (
		<div className={cn("rounded-md border px-3 py-2 text-sm font-medium", tone)}>
			{parts.join(" · ")}
			{answer.citations.some((citation) => citation.owner === "OWN") && " · 引用了你的官网"}
		</div>
	);
}

function CitationList({ citations }: { citations: ConsoleCitation[] }) {
	if (citations.length === 0) {
		return <p className="text-xs text-muted-foreground">这次回答没有列出引用来源。</p>;
	}
	return (
		<ol className="flex flex-col gap-1.5">
			{citations.map((citation) => (
				<li key={citation.ordinal} className="flex items-start gap-2 text-sm">
					<span className="w-5 shrink-0 text-right text-xs text-muted-foreground">{citation.ordinal}.</span>
					<div className="min-w-0 flex-1">
						<a
							href={citation.url}
							target="_blank"
							rel="noopener noreferrer"
							className="inline-flex max-w-full items-center gap-1 hover:underline"
						>
							<span className="truncate">{citation.title || citation.host || citation.url}</span>
							<IconExternalLink className="size-3 shrink-0 text-muted-foreground" />
						</a>
						{citation.title && citation.host && (
							<span className="block truncate text-xs text-muted-foreground">{citation.host}</span>
						)}
					</div>
					{citation.owner === "OWN" && (
						<Badge className="shrink-0 border-transparent bg-emerald-100 text-emerald-900">引用了你的官网</Badge>
					)}
					{citation.owner === "COMPETITOR" && (
						<Badge className="shrink-0 border-transparent bg-orange-100 text-orange-900">
							竞品网站{citation.ownerName ? `：${citation.ownerName}` : ""}
						</Badge>
					)}
				</li>
			))}
		</ol>
	);
}

/**
 * The buyer's question and the AI's answer as a chat, with the answer typed out once,
 * then the verdict and the sources it cited.
 */
export function ChatTranscript({
	answer,
	animate = true,
	compact = false,
}: {
	answer: ConsoleAnswer;
	animate?: boolean;
	compact?: boolean;
}) {
	const { shown, done, showAll } = useTypewriter(answer.answerText.length, animate);
	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
				<span className="font-medium text-foreground">{channelLabel(answer.platform, answer.surfaceMode)}</span>
				<span>
					{answer.source === "live" ? "实时提问于" : "采样于"} {formatDateTime(answer.sampledAt)}
				</span>
			</div>

			<div className="flex items-start justify-end gap-2">
				<div className="max-w-[85%] rounded-2xl rounded-tr-sm bg-primary px-4 py-2.5 text-sm text-primary-foreground">
					{answer.buyerRoleTitle && <p className="mb-1 text-xs opacity-80">{answer.buyerRoleTitle}提问</p>}
					<p className="whitespace-pre-wrap">{answer.questionText}</p>
				</div>
				<span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted">
					<IconUser className="size-4" />
				</span>
			</div>

			<div className="flex items-start gap-2">
				<span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted">
					<IconRobot className="size-4" />
				</span>
				<div
					className={cn(
						"min-w-0 flex-1 rounded-2xl rounded-tl-sm border bg-card px-4 py-3",
						compact && "max-h-[28rem] overflow-y-auto",
					)}
					aria-busy={!done}
				>
					<AnswerText text={answer.answerText} segments={answer.segments} shown={shown} />
					{!done && (
						<Button variant="link" size="sm" className="mt-1 h-auto px-0" onClick={showAll}>
							显示全部
						</Button>
					)}
				</div>
			</div>

			{done && (
				<>
					<OutcomeStrip answer={answer} />
					<div className="flex flex-col gap-2">
						<p className="text-xs font-medium text-muted-foreground">引用来源</p>
						<CitationList citations={answer.citations} />
					</div>
				</>
			)}
		</div>
	);
}
