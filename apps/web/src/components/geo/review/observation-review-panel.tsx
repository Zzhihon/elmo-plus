import { useQuery } from "@tanstack/react-query";
import {
	GEO_CITATION_OWNER_LABELS,
	GEO_CLAIM_KIND_LABELS,
	GEO_CLAIM_MATCH_LABELS,
	GEO_CLAIM_VERDICT_LABELS,
	GEO_RECOMMENDATION_LABELS,
	GEO_REVIEW_REASON_LABELS,
	type GeoEvidenceSpanKind,
	type GeoLlmSignals,
} from "@workspace/geo-domain";
import { Button } from "@workspace/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@workspace/ui/components/card";
import { Skeleton } from "@workspace/ui/components/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@workspace/ui/components/table";
import { type ReactNode, useState } from "react";
import { insightKeys } from "@/components/geo/insights/search";
import { formatDateTime } from "@/components/geo/sampling/format";
import { useGeoOrganization } from "@/components/geo/sampling/use-geo-organization";
import { GeoEvaluationReviewBadge, GeoStatusBadge } from "@/components/geo/shell/status-badge";
import { useGeoViewer } from "@/components/geo/shell/use-geo-viewer";
import { CreateTaskFromEvidence } from "@/components/geo/tasks/create-task-from-evidence";
import { getObservationReviewFn } from "@/server/geo/evaluation";
import type { ReviewClaim, ReviewEvaluation } from "@/server/geo/evaluation-core";
import type { ObservationDetail } from "@/server/geo/observations-core";
import { ClaimReviewDialog, EvaluationReviewDialog } from "./review-dialogs";

const SPAN_LABELS: Record<GeoEvidenceSpanKind, string> = {
	BRAND: "品牌提及",
	COMPETITOR: "竞品提及",
	RECOMMENDATION: "推荐表述",
	NEGATIVE: "负面表述",
	RANK: "排序位置",
	CLAIM: "事实断言",
};

function Field({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="flex flex-col gap-0.5">
			<span className="text-xs text-muted-foreground">{label}</span>
			<span className="text-sm">{children}</span>
		</div>
	);
}

function isModelSignals(value: unknown): value is GeoLlmSignals {
	return typeof value === "object" && value !== null && "recommendation" in value;
}

function rankText(evaluation: ReviewEvaluation): string {
	if (!evaluation.hasOrderedList) return "无可判定排序";
	return evaluation.brandRank ? `第 ${evaluation.brandRank} 位` : "清单中未出现";
}

function ModelLine({ llm }: { llm: unknown }) {
	if (!llm) return <div className="text-muted-foreground">未调用模型（组织未批准或未启用），结论仅来自规则。</div>;
	if (!isModelSignals(llm)) return <div className="text-muted-foreground">模型调用失败，结论仅来自规则。</div>;
	const quote = llm.evidenceQuote
		? llm.quoteFound
			? `，引用原文“${llm.evidenceQuote}”`
			: "，所给引文不在原文中，已忽略"
		: "";
	return (
		<div>
			模型判断：{GEO_RECOMMENDATION_LABELS[llm.recommendation]}（置信度 {llm.confidence.toFixed(2)}）{quote}
			<span className="text-xs text-muted-foreground">（模型判断只用于发现分歧，不直接决定结论）</span>
		</div>
	);
}

function Signals({ signals }: { signals: NonNullable<ReviewEvaluation["signals"]> }) {
	const { rules } = signals;
	return (
		<div className="rounded-md border bg-muted/30 p-3 text-sm">
			<div>
				规则判断：{GEO_RECOMMENDATION_LABELS[rules.recommendation]}（置信度 {rules.confidence.toFixed(2)}）
				{rules.cues.length > 0 && `，依据词：${rules.cues.join("、")}`}
			</div>
			<ModelLine llm={signals.llm} />
		</div>
	);
}

const SPAN_TONE: Record<GeoEvidenceSpanKind, "danger" | "warning" | "info"> = {
	BRAND: "info",
	COMPETITOR: "info",
	RECOMMENDATION: "info",
	NEGATIVE: "danger",
	RANK: "info",
	CLAIM: "warning",
};

function EvidenceSpans({ evaluation }: { evaluation: ReviewEvaluation }) {
	const spans = evaluation.evidenceSpans.filter(
		(span, index, all) => all.findIndex((other) => other.start === span.start && other.kind === span.kind) === index,
	);
	return (
		<div className="flex flex-col gap-1.5">
			<span className="text-xs text-muted-foreground">证据片段</span>
			{spans.length === 0 ? (
				<span className="text-sm text-muted-foreground">回答中没有命中品牌、竞品或推荐表述。</span>
			) : (
				<ul className="flex flex-col gap-1 text-sm">
					{spans.slice(0, 20).map((span) => (
						<li key={`${span.kind}-${span.start}`} className="flex gap-2">
							<GeoStatusBadge label={SPAN_LABELS[span.kind]} tone={SPAN_TONE[span.kind]} />
							<span className="whitespace-pre-wrap">“{span.text}”</span>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

function competitorText(evaluation: ReviewEvaluation): string {
	return evaluation.competitorHits
		.filter((hit) => hit.mentioned)
		.map(
			(hit) =>
				`${hit.name}（${GEO_RECOMMENDATION_LABELS[hit.recommendation]}${hit.rank ? `，第 ${hit.rank} 位` : ""}）`,
		)
		.join("；");
}

function CurrentEvaluation({ evaluation }: { evaluation: ReviewEvaluation }) {
	const competitors = competitorText(evaluation);
	return (
		<div className="flex flex-col gap-4">
			<div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
				<Field label="结论">{GEO_RECOMMENDATION_LABELS[evaluation.recommendation]}</Field>
				<Field label="品牌提及">{evaluation.brandMentioned ? "是" : "否"}</Field>
				<Field label="排序">{rankText(evaluation)}</Field>
				<Field label="置信度">{evaluation.confidence === null ? "—" : evaluation.confidence.toFixed(2)}</Field>
				<Field label="复核状态">
					<GeoEvaluationReviewBadge status={evaluation.reviewStatus} />
				</Field>
				<Field label="评估规则版本">{evaluation.evaluatorVersion}</Field>
				<Field label="品牌词典版本">{evaluation.dictionaryVersion ? `v${evaluation.dictionaryVersion}` : "—"}</Field>
				<Field label="评估时间">{formatDateTime(evaluation.createdAt)}</Field>
			</div>
			{evaluation.reviewReasons.length > 0 && (
				<div className="flex flex-wrap items-center gap-2">
					<span className="text-xs text-muted-foreground">进入复核的原因</span>
					{evaluation.reviewReasons.map((reason) => (
						<GeoStatusBadge key={reason} label={GEO_REVIEW_REASON_LABELS[reason]} tone="warning" />
					))}
				</div>
			)}
			{evaluation.signals && <Signals signals={evaluation.signals} />}
			<EvidenceSpans evaluation={evaluation} />
			{competitors && <Field label="竞品">{competitors}</Field>}
			{evaluation.citationAttribution.length > 0 && (
				<Field label="引用归属">
					{evaluation.citationAttribution
						.map((citation) => `${citation.host ?? "无法识别"}（${GEO_CITATION_OWNER_LABELS[citation.owner]}）`)
						.join("；")}
				</Field>
			)}
		</div>
	);
}

function VersionHistory({ evaluations }: { evaluations: ReviewEvaluation[] }) {
	return (
		<Table>
			<TableHeader>
				<TableRow>
					<TableHead>版本</TableHead>
					<TableHead>结论</TableHead>
					<TableHead>品牌提及</TableHead>
					<TableHead>排名</TableHead>
					<TableHead>复核状态</TableHead>
					<TableHead>操作人</TableHead>
					<TableHead>依据</TableHead>
					<TableHead>时间</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				{evaluations.map((evaluation) => (
					<TableRow key={evaluation.id}>
						<TableCell className="tabular-nums">
							v{evaluation.version}
							{evaluation.isCurrent && <GeoStatusBadge className="ml-2" label="当前" tone="info" />}
						</TableCell>
						<TableCell>{GEO_RECOMMENDATION_LABELS[evaluation.recommendation]}</TableCell>
						<TableCell>{evaluation.brandMentioned ? "是" : "否"}</TableCell>
						<TableCell className="tabular-nums">{evaluation.brandRank ?? "—"}</TableCell>
						<TableCell>
							<GeoEvaluationReviewBadge status={evaluation.reviewStatus} />
						</TableCell>
						<TableCell className="text-xs">
							{evaluation.createdBy.startsWith("system:") ? "系统" : evaluation.createdBy}
						</TableCell>
						<TableCell className="max-w-64 whitespace-normal text-xs">{evaluation.reason ?? "—"}</TableCell>
						<TableCell className="whitespace-nowrap text-xs">{formatDateTime(evaluation.createdAt)}</TableCell>
					</TableRow>
				))}
			</TableBody>
		</Table>
	);
}

type ClaimVerdictChoice = "CORRECT" | "ERROR" | "UNVERIFIED";

const MATCH_TONE = { MISMATCH: "danger", MATCHED: "success", NO_REFERENCE: "neutral" } as const;
const VERDICT_TONE = { ERROR: "danger", CORRECT: "success", UNVERIFIED: "neutral" } as const;
const VERDICT_ACTIONS: { verdict: ClaimVerdictChoice; label: string; variant: "outline" | "ghost" }[] = [
	{ verdict: "CORRECT", label: "正确", variant: "outline" },
	{ verdict: "ERROR", label: "确认错误", variant: "outline" },
	{ verdict: "UNVERIFIED", label: "待核实", variant: "ghost" },
];

function ClaimRow({
	claim,
	canReview,
	onAction,
}: {
	claim: ReviewClaim;
	canReview: boolean;
	onAction: (verdict: ClaimVerdictChoice) => void;
}) {
	return (
		<TableRow>
			<TableCell>{GEO_CLAIM_KIND_LABELS[claim.claimKind]}</TableCell>
			<TableCell className="max-w-md whitespace-normal text-sm">
				{claim.claimText}
				{claim.reviewNote && <div className="text-xs text-muted-foreground">意见：{claim.reviewNote}</div>}
			</TableCell>
			<TableCell className="font-mono text-xs">{claim.extractedValue ?? "—"}</TableCell>
			<TableCell className="font-mono text-xs">{claim.referenceValue ?? "—"}</TableCell>
			<TableCell>
				<GeoStatusBadge label={GEO_CLAIM_MATCH_LABELS[claim.matchStatus]} tone={MATCH_TONE[claim.matchStatus]} />
			</TableCell>
			<TableCell>
				<GeoStatusBadge label={GEO_CLAIM_VERDICT_LABELS[claim.verdict]} tone={VERDICT_TONE[claim.verdict]} />
			</TableCell>
			{canReview && (
				<TableCell className="whitespace-nowrap text-right">
					<div className="flex justify-end gap-1">
						{VERDICT_ACTIONS.filter((action) => action.verdict !== claim.verdict).map((action) => (
							<Button key={action.verdict} size="sm" variant={action.variant} onClick={() => onAction(action.verdict)}>
								{action.label}
							</Button>
						))}
					</div>
				</TableCell>
			)}
		</TableRow>
	);
}

function ClaimTable({ observationId, claims }: { observationId: string; claims: ReviewClaim[] }) {
	const viewer = useGeoViewer();
	const [action, setAction] = useState<{ claim: ReviewClaim; verdict: ClaimVerdictChoice } | null>(null);
	const canReview = viewer.can("claim.review");
	return (
		<>
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead>类型</TableHead>
						<TableHead className="min-w-64">陈述</TableHead>
						<TableHead>回答值</TableHead>
						<TableHead>已审核值</TableHead>
						<TableHead>比对</TableHead>
						<TableHead>结论</TableHead>
						{canReview && <TableHead className="text-right">技术审核</TableHead>}
					</TableRow>
				</TableHeader>
				<TableBody>
					{claims.map((claim) => (
						<ClaimRow
							key={claim.id}
							claim={claim}
							canReview={canReview}
							onAction={(verdict) => setAction({ claim, verdict })}
						/>
					))}
				</TableBody>
			</Table>
			{action && (
				<ClaimReviewDialog
					observationId={observationId}
					claim={action.claim}
					verdict={action.verdict}
					onClose={() => setAction(null)}
				/>
			)}
		</>
	);
}

/**
 * Evaluation and review for one observation: the current conclusion and the evidence
 * spans behind it, every version, reviewer actions, and the fact claims for technical review.
 */
export function GeoObservationReviewPanel({ observation }: { observation: ObservationDetail }) {
	const organization = useGeoOrganization();
	const viewer = useGeoViewer();
	const [reviewing, setReviewing] = useState<"CONFIRM" | "CORRECT" | null>(null);
	const review = useQuery({
		queryKey: insightKeys.review(organization.id, observation.id),
		queryFn: () => getObservationReviewFn({ data: { organizationId: organization.id, observationId: observation.id } }),
	});
	const current = review.data?.evaluations.find((evaluation) => evaluation.isCurrent) ?? null;
	const canReview = viewer.can("observation.review");

	return (
		<>
			<Card>
				<CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
					<div className="flex flex-col gap-1.5">
						<CardTitle>评估与复核</CardTitle>
						<CardDescription>
							更正只会追加新的评估版本，原始回答保持不变。
							{!observation.countsInRates && "此样本未取得完整回答，不计入任何比率，也不会被判定为“未提及”。"}
						</CardDescription>
					</div>
					<div className="flex flex-wrap gap-2">
						{current && canReview && (
							<>
								<Button size="sm" variant="outline" onClick={() => setReviewing("CONFIRM")}>
									确认结论
								</Button>
								<Button size="sm" onClick={() => setReviewing("CORRECT")}>
									更正结论
								</Button>
							</>
						)}
						{current && (
							<CreateTaskFromEvidence
								sourceKind="OBSERVATION"
								sourceRef={`observation:${observation.id}`}
								evidence={{ observationIds: [observation.id] }}
								promptId={observation.promptId}
								defaultTitle={`优化问法：${observation.questionText}`.slice(0, 120)}
								defaultKind="SELECTION_GUIDE"
							/>
						)}
					</div>
				</CardHeader>
				<CardContent className="flex flex-col gap-6">
					{review.isLoading && <Skeleton className="h-40 w-full" />}
					{review.error && <p className="text-sm text-destructive">{review.error.message}</p>}
					{review.data && !current && (
						<p className="text-sm text-muted-foreground">
							{observation.countsInRates || observation.status === "PARTIAL"
								? "尚未评估，评估作业完成后会显示在这里。"
								: "该样本不参与评估。"}
						</p>
					)}
					{current && <CurrentEvaluation evaluation={current} />}
					{review.data && review.data.evaluations.length > 0 && (
						<div className="flex flex-col gap-2">
							<span className="text-sm font-medium">全部评估版本</span>
							<VersionHistory evaluations={review.data.evaluations} />
						</div>
					)}
				</CardContent>
			</Card>
			{review.data && review.data.claims.length > 0 && (
				<Card>
					<CardHeader>
						<CardTitle>事实断言</CardTitle>
						<CardDescription>
							从回答中抽取的本品牌数字、型号与证书陈述，与已审核知识比对。无法核实的陈述保持“待核实”，不算错误；只有技术审核人能确认错误。
						</CardDescription>
					</CardHeader>
					<CardContent>
						<ClaimTable observationId={observation.id} claims={review.data.claims} />
					</CardContent>
				</Card>
			)}
			{reviewing && current && (
				<EvaluationReviewDialog
					observationId={observation.id}
					current={current}
					mode={reviewing}
					onClose={() => setReviewing(null)}
				/>
			)}
		</>
	);
}
