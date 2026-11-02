import { type GeoBrandKind, type GeoDictionarySnapshot, normalizeBrandTerm } from "@workspace/geo-domain";
import { isAsciiWordChar, isHan, type MatchText, originalRange, toMatchText } from "./text";

export interface DictionaryTerm {
	entityId: string;
	kind: GeoBrandKind;
	entityName: string;
	term: string;
}

export interface AliasHit {
	entityId: string;
	kind: GeoBrandKind;
	entityName: string;
	term: string;
	/** Range in the stored answer. */
	start: number;
	end: number;
	text: string;
}

/** Every name a currently active brand or competitor goes by in this dictionary version, normalised. */
export function dictionaryTerms(snapshot: GeoDictionarySnapshot): DictionaryTerm[] {
	const terms: DictionaryTerm[] = [];
	for (const entity of snapshot.entities) {
		if (entity.status !== "ACTIVE") continue;
		const names = [
			entity.displayName,
			entity.legalName,
			entity.shortName,
			...entity.aliases,
			...entity.historicalNames,
			...entity.domains.map((domain) => domain.replace(/^www\./, "")),
		];
		const seen = new Set<string>();
		for (const name of names) {
			if (!name) continue;
			const term = normalizeBrandTerm(name);
			if (!term || seen.has(term)) continue;
			seen.add(term);
			terms.push({ entityId: entity.id, kind: entity.kind, entityName: entity.displayName, term });
		}
	}
	return terms;
}

/**
 * Words that may directly follow a short Chinese brand name. Chinese has no spaces, so
 * a two-character alias also occurs inside unrelated longer words; requiring one of
 * these (or any non-Chinese character) after it is what tells "<alias>的产品" from a
 * longer word that merely starts with the same two characters.
 */
const SHORT_NAME_FOLLOWERS = [
	"电气",
	"电器",
	"集团",
	"公司",
	"股份",
	"品牌",
	"牌",
	"产品",
	"设备",
	"成套",
	"旗下",
	"系列",
	"官网",
	"作为",
	"推出",
	"凭借",
	"拥有",
	"具有",
	"提供",
	"获得",
	"值得",
	"主要",
	"的",
	"和",
	"与",
	"及",
	"或",
	"等",
	"是",
	"为",
	"在",
	"也",
	"都",
	"有",
	"这",
	"家",
	"了",
	"还",
	"则",
	"以",
	"被",
	"将",
	"对",
	"从",
	"会",
	"能",
	"可",
	"不",
	"很",
	"较",
	"更",
	"最",
	"已",
	"并",
	"但",
	"而",
	"因",
	"就",
	"又",
	"均",
	"该",
	"其",
	"于",
	"首",
];

const SHORT_HAN_TERM = 2;

function isAllHan(term: string): boolean {
	return [...term].every((char) => isHan(char));
}

function withinBoundaries(text: string, term: string, start: number): boolean {
	const end = start + term.length;
	const before = text[start - 1];
	const after = text[end];
	if (isAsciiWordChar(term[0]) && isAsciiWordChar(before)) return false;
	if (isAsciiWordChar(term[term.length - 1]) && isAsciiWordChar(after)) return false;
	if (isAllHan(term) && [...term].length <= SHORT_HAN_TERM && isHan(after)) {
		return SHORT_NAME_FOLLOWERS.some((follower) => text.startsWith(follower, end));
	}
	return true;
}

interface Candidate {
	term: DictionaryTerm;
	start: number;
	end: number;
}

/**
 * Deterministic brand and competitor matching. The longest name wins where matches
 * overlap, so a competitor whose name contains the brand's short name is not counted
 * as the brand, and short Chinese names must stand on a word boundary.
 */
export function findAliasHits(answer: string, terms: readonly DictionaryTerm[], match?: MatchText): AliasHit[] {
	const normalized = match ?? toMatchText(answer);
	const { text } = normalized;
	const candidates: Candidate[] = [];
	for (const term of terms) {
		let from = 0;
		while (from <= text.length - term.term.length) {
			const at = text.indexOf(term.term, from);
			if (at < 0) break;
			if (withinBoundaries(text, term.term, at)) candidates.push({ term, start: at, end: at + term.term.length });
			from = at + 1;
		}
	}
	candidates.sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start);
	const taken: Candidate[] = [];
	for (const candidate of candidates) {
		if (taken.some((other) => candidate.start < other.end && other.start < candidate.end)) continue;
		taken.push(candidate);
	}
	return taken
		.sort((a, b) => a.start - b.start)
		.map(({ term, start, end }) => {
			const range = originalRange(normalized, start, end);
			return {
				entityId: term.entityId,
				kind: term.kind,
				entityName: term.entityName,
				term: term.term,
				start: range.start,
				end: range.end,
				text: answer.slice(range.start, range.end),
			};
		});
}
