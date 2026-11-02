import type { GeoEvidenceSpan, GeoRecommendation } from "@workspace/geo-domain";
import type { AliasHit } from "./alias-match";
import { findOrderedLists, type OrderedList, rankAt } from "./ordered-list";
import { rangeContaining, sentenceRanges, type TextRange, trimmedRange } from "./text";

const NEGATIVE_CUES = [
	"不推荐",
	"不建议",
	"不太推荐",
	"慎选",
	"谨慎选择",
	"慎重考虑",
	"投诉",
	"质量问题",
	"负面",
	"纠纷",
	"处罚",
	"召回",
	"差评",
	"避免选择",
	"警惕",
	"不靠谱",
	"虚假宣传",
	"存在风险",
	"风险较高",
	"售后差",
	"口碑差",
	"口碑不佳",
	"问题较多",
];

const POSITIVE_CUES = [
	"推荐",
	"首选",
	"首推",
	"优先考虑",
	"优先选择",
	"值得考虑",
	"值得信赖",
	"值得选择",
	"可以考虑",
	"可以选择",
	"建议选择",
	"建议考虑",
	"口碑好",
	"口碑良好",
	"性价比高",
	"实力强",
	"实力雄厚",
	"知名",
	"领先",
	"优质",
	"可靠",
	"靠谱",
	"代表性",
	"表现突出",
	"信誉良好",
];

const NEGATORS = ["不是", "并非", "没有", "未", "不", "非"];

/** Words before a numbered list that say it is a ranking or a shortlist rather than, say, a list of criteria. */
const LIST_INTRO_CUES = ["推荐", "排名", "排行", "首选", "品牌", "厂家", "厂商", "供应商", "企业", "公司", "选择"];

export interface RecommendationJudgement {
	recommendation: GeoRecommendation;
	confidence: number;
	cues: string[];
	spans: GeoEvidenceSpan[];
	rank: number | null;
}

interface CueHit {
	cue: string;
	start: number;
	end: number;
}

function findCues(text: string, range: TextRange, cues: readonly string[]): CueHit[] {
	const hits: CueHit[] = [];
	const slice = text.slice(range.start, range.end);
	for (const cue of cues) {
		let from = 0;
		while (true) {
			const at = slice.indexOf(cue, from);
			if (at < 0) break;
			hits.push({ cue, start: range.start + at, end: range.start + at + cue.length });
			from = at + cue.length;
		}
	}
	return hits;
}

function negated(text: string, hit: CueHit): boolean {
	const before = text.slice(Math.max(0, hit.start - 2), hit.start);
	return NEGATORS.some((negator) => before.endsWith(negator));
}

function overlaps(a: CueHit, b: CueHit): boolean {
	return a.start < b.end && b.start < a.end;
}

export interface AnswerStructure {
	sentences: TextRange[];
	lists: OrderedList[];
	/** The first list that ranks at least one dictionary name in an item's first line: the only kind a rank is read from. */
	rankingList: OrderedList | null;
	rankingListIsRecommendation: boolean;
}

export function analyseStructure(text: string, hits: readonly AliasHit[]): AnswerStructure {
	const lists = findOrderedLists(text);
	const rankingList = lists.find((list) => hits.some((hit) => rankAt(list, hit.start) !== null)) ?? null;
	let rankingListIsRecommendation = false;
	if (rankingList) {
		const intro = text.slice(Math.max(0, rankingList.start - 120), rankingList.start);
		rankingListIsRecommendation = LIST_INTRO_CUES.some((cue) => intro.includes(cue));
	}
	return { sentences: sentenceRanges(text), lists, rankingList, rankingListIsRecommendation };
}

function span(text: string, kind: GeoEvidenceSpan["kind"], range: TextRange, entityId?: string): GeoEvidenceSpan {
	return {
		kind,
		start: range.start,
		end: range.end,
		text: text.slice(range.start, range.end),
		entityId: entityId ?? null,
	};
}

interface SentenceCues {
	negatives: CueHit[];
	positives: CueHit[];
	span: GeoEvidenceSpan | null;
}

/** Cues in one sentence; a positive cue right after a negator ("不是首选") counts as negative. */
function sentenceCues(text: string, sentence: TextRange): SentenceCues {
	const plainNegatives = findCues(text, sentence, NEGATIVE_CUES);
	const candidates = findCues(text, sentence, POSITIVE_CUES).filter(
		(positive) => !plainNegatives.some((negative) => overlaps(negative, positive)),
	);
	const turned = candidates.filter((positive) => negated(text, positive));
	const negatives = [...plainNegatives, ...turned];
	const positives = candidates.filter((positive) => !turned.includes(positive));
	const kind = negatives.length > 0 ? "NEGATIVE" : positives.length > 0 ? "RECOMMENDATION" : null;
	return { negatives, positives, span: kind ? span(text, kind, trimmedRange(text, sentence)) : null };
}

function rankOf(text: string, entityHits: readonly AliasHit[], structure: AnswerStructure) {
	const list = structure.rankingList;
	if (!list) return { rank: null, span: null };
	const rank = entityHits.map((hit) => rankAt(list, hit.start)).find((value) => value !== null) ?? null;
	const item = rank === null ? undefined : list.items[rank - 1];
	return { rank, span: item ? span(text, "RANK", trimmedRange(text, item.head)) : null };
}

function decide(
	negatives: number,
	positives: number,
	rankedInRecommendationList: boolean,
): { recommendation: GeoRecommendation; confidence: number } {
	if (negatives > 0 && positives > 0) return { recommendation: "MENTIONED_ONLY", confidence: 0.4 };
	if (negatives > 0) return { recommendation: "NEGATIVE", confidence: 0.75 };
	if (positives > 0) return { recommendation: "RECOMMENDED", confidence: 0.8 };
	if (rankedInRecommendationList) return { recommendation: "RECOMMENDED", confidence: 0.7 };
	return { recommendation: "MENTIONED_ONLY", confidence: 0.7 };
}

/**
 * Rule judgement for one brand or competitor: what the sentences naming it say about it.
 * A negative cue wins over a positive one only when the positive is absent; both at once
 * is a contradiction the rules cannot settle, so it comes back with low confidence.
 */
export function judgeEntity(
	text: string,
	entityHits: readonly AliasHit[],
	structure: AnswerStructure,
	spanKind: "BRAND" | "COMPETITOR",
): RecommendationJudgement {
	if (entityHits.length === 0) {
		return { recommendation: "NOT_MENTIONED", confidence: 0.95, cues: [], spans: [], rank: null };
	}
	const spans: GeoEvidenceSpan[] = entityHits.map((hit) => span(text, spanKind, hit, hit.entityId));
	const sentences = new Map<number, TextRange>();
	for (const hit of entityHits) {
		const sentence = rangeContaining(structure.sentences, hit.start);
		if (sentence) sentences.set(sentence.start, sentence);
	}
	const negatives: CueHit[] = [];
	const positives: CueHit[] = [];
	for (const sentence of sentences.values()) {
		const found = sentenceCues(text, sentence);
		negatives.push(...found.negatives);
		positives.push(...found.positives);
		if (found.span) spans.push(found.span);
	}
	const ranked = rankOf(text, entityHits, structure);
	if (ranked.span) spans.push(ranked.span);
	const listed = ranked.rank !== null && structure.rankingListIsRecommendation;
	const decision = decide(negatives.length, positives.length, listed);
	const cues = [...new Set([...negatives, ...positives].map((hit) => hit.cue))];
	if (listed && negatives.length === 0 && positives.length === 0) cues.push("推荐清单");
	return { ...decision, cues, spans, rank: ranked.rank };
}
