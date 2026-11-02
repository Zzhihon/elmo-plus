import {
	GEO_HIGH_PRIORITY_PROMPTS,
	type GeoCitationAttribution,
	type GeoCompetitorHit,
	type GeoDictionarySnapshot,
	type GeoEvaluationReviewStatus,
	type GeoEvaluationSignals,
	type GeoEvidenceSpan,
	type GeoLlmSignals,
	type GeoPriority,
	type GeoRecommendation,
	type GeoReviewReason,
} from "@workspace/geo-domain";
import { type AliasHit, dictionaryTerms, findAliasHits } from "./alias-match";
import { attributeCitations, type CitationInput } from "./citations";
import { type ApprovedAssertion, type CheckedClaim, checkClaims, extractClaims } from "./claims";
import { analyseStructure, judgeEntity } from "./semantic";

/** Bump when a rule changes what an answer evaluates to: trends break at a version change. */
export const GEO_RULES_EVALUATOR_VERSION = "rules-v1";

/** Below this, an automatic judgement is not trusted without a reviewer. */
export const GEO_LOW_CONFIDENCE = 0.6;

export interface RuleEvaluation {
	brandMentioned: boolean;
	recommendation: GeoRecommendation;
	hasOrderedList: boolean;
	brandRank: number | null;
	confidence: number;
	cues: string[];
	competitorHits: GeoCompetitorHit[];
	evidenceSpans: GeoEvidenceSpan[];
	citationAttribution: GeoCitationAttribution[];
	claims: CheckedClaim[];
	productHits: string[];
}

export interface RuleEvaluationInput {
	answer: string;
	dictionary: GeoDictionarySnapshot;
	citations: readonly CitationInput[];
	approvedAssertions: readonly ApprovedAssertion[];
}

function hitsBy(hits: readonly AliasHit[], entityId: string): AliasHit[] {
	return hits.filter((hit) => hit.entityId === entityId);
}

export function evaluateWithRules(input: RuleEvaluationInput): RuleEvaluation {
	const { answer, dictionary } = input;
	const hits = findAliasHits(answer, dictionaryTerms(dictionary));
	const structure = analyseStructure(answer, hits);
	const ownHits = hits.filter((hit) => hit.kind === "OWN");
	const brand = judgeEntity(answer, ownHits, structure, "BRAND");

	const competitorHits: GeoCompetitorHit[] = [];
	const competitorSpans: GeoEvidenceSpan[] = [];
	for (const entity of dictionary.entities) {
		if (entity.kind !== "COMPETITOR" || entity.status !== "ACTIVE") continue;
		const judgement = judgeEntity(answer, hitsBy(hits, entity.id), structure, "COMPETITOR");
		competitorHits.push({
			entityId: entity.id,
			name: entity.displayName,
			mentioned: judgement.recommendation !== "NOT_MENTIONED",
			recommendation: judgement.recommendation,
			rank: judgement.rank,
		});
		competitorSpans.push(...judgement.spans.filter((span) => span.kind === "COMPETITOR"));
	}

	const claims = checkClaims(extractClaims(answer, ownHits, dictionary), input.approvedAssertions, dictionary);
	const productHits = [...new Set(claims.filter((claim) => claim.subject).map((claim) => claim.subject as string))];
	return {
		brandMentioned: ownHits.length > 0,
		recommendation: brand.recommendation,
		hasOrderedList: structure.rankingList !== null,
		brandRank: brand.rank,
		confidence: brand.confidence,
		cues: brand.cues,
		competitorHits,
		evidenceSpans: [
			...brand.spans,
			...competitorSpans,
			...claims.map((claim) => ({
				kind: "CLAIM" as const,
				start: claim.span.start,
				end: claim.span.end,
				text: answer.slice(claim.span.start, claim.span.end),
			})),
		],
		citationAttribution: attributeCitations(input.citations, dictionary),
		claims,
		productHits,
	};
}

export type LlmOutcome = GeoLlmSignals | { error: string } | null;

export interface FinalEvaluation {
	evaluatorVersion: string;
	brandMentioned: boolean;
	recommendation: GeoRecommendation;
	hasOrderedList: boolean;
	brandRank: number | null;
	confidence: number;
	reviewStatus: GeoEvaluationReviewStatus;
	reviewReasons: GeoReviewReason[];
	reviewPriority: number;
	signals: GeoEvaluationSignals;
}

const PRIORITY_WEIGHT: Record<GeoPriority, number> = { P0: 400, P1: 300, P2: 200, P3: 100 };
const REASON_WEIGHT: Record<GeoReviewReason, number> = {
	CLAIM_MISMATCH: 60,
	LLM_DISAGREES: 40,
	TECHNICAL_CLAIM: 30,
	LOW_CONFIDENCE: 20,
	RULES_ONLY_JUDGEMENT: 10,
	HIGH_PRIORITY_PROMPT: 0,
};

export function reviewPriorityOf(priority: GeoPriority | null, reasons: readonly GeoReviewReason[]): number {
	return (
		(priority ? PRIORITY_WEIGHT[priority] : PRIORITY_WEIGHT.P2) +
		reasons.reduce((sum, reason) => sum + REASON_WEIGHT[reason], 0)
	);
}

function isLlmSignals(outcome: LlmOutcome): outcome is GeoLlmSignals {
	return outcome !== null && !("error" in outcome);
}

function modelAgrees(rules: RuleEvaluation, model: GeoLlmSignals): boolean {
	return (
		model.recommendation === rules.recommendation &&
		model.brandMentioned === rules.brandMentioned &&
		(!rules.hasOrderedList || !model.hasOrderedList || model.brandRank === rules.brandRank)
	);
}

/** Confidence after hearing the model, and whether it disagreed. */
function weighModel(rules: RuleEvaluation, model: GeoLlmSignals | null): { confidence: number; disagrees: boolean } {
	if (!model) return { confidence: rules.confidence, disagrees: false };
	if (!modelAgrees(rules, model)) return { confidence: Math.min(rules.confidence, 0.5), disagrees: true };
	return {
		confidence: Math.min(0.99, Math.max(rules.confidence, (rules.confidence + model.confidence) / 2 + 0.1)),
		disagrees: false,
	};
}

/**
 * The model can only send a result to review, never decide it: the stored values are
 * the rules' whenever the two disagree. Low confidence, a high-value question, a
 * technical claim, or a recommendation the rules alone produced all go to a reviewer.
 */
export function finalizeEvaluation(
	rules: RuleEvaluation,
	llm: LlmOutcome,
	promptPriority: GeoPriority | null,
): FinalEvaluation {
	const model = isLlmSignals(llm) ? llm : null;
	const { confidence, disagrees } = weighModel(rules, model);
	const judged = rules.recommendation === "RECOMMENDED" || rules.recommendation === "NEGATIVE";
	const checks: [boolean, GeoReviewReason][] = [
		[disagrees, "LLM_DISAGREES"],
		[!model && judged, "RULES_ONLY_JUDGEMENT"],
		[confidence < GEO_LOW_CONFIDENCE, "LOW_CONFIDENCE"],
		[promptPriority !== null && GEO_HIGH_PRIORITY_PROMPTS.includes(promptPriority), "HIGH_PRIORITY_PROMPT"],
		[rules.claims.length > 0, "TECHNICAL_CLAIM"],
		[rules.claims.some((claim) => claim.matchStatus === "MISMATCH"), "CLAIM_MISMATCH"],
	];
	const reasons = checks.filter(([applies]) => applies).map(([, reason]) => reason);

	const reviewReasons = reasons;
	return {
		evaluatorVersion: model
			? `${GEO_RULES_EVALUATOR_VERSION}+llm:${model.model ?? "unknown"}`
			: GEO_RULES_EVALUATOR_VERSION,
		brandMentioned: rules.brandMentioned,
		recommendation: rules.recommendation,
		hasOrderedList: rules.hasOrderedList,
		brandRank: rules.brandRank,
		confidence: Math.round(confidence * 100) / 100,
		reviewStatus: reviewReasons.length > 0 ? "PENDING_REVIEW" : "AUTO_ACCEPTED",
		reviewReasons,
		reviewPriority: reviewReasons.length > 0 ? reviewPriorityOf(promptPriority, reviewReasons) : 0,
		signals: {
			rules: { recommendation: rules.recommendation, confidence: rules.confidence, cues: rules.cues },
			llm,
			productHits: rules.productHits,
		},
	};
}

/** Verifies the model's quote really is in the answer before it is shown as evidence. */
export function locateQuote(answer: string, quote: string | null): boolean {
	if (!quote) return false;
	const trimmed = quote.trim();
	return trimmed.length >= 2 && answer.includes(trimmed);
}
