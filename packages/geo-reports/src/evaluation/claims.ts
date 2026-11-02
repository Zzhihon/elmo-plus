import type {
	GeoClaimKind,
	GeoClaimMatchStatus,
	GeoClaimVerdict,
	GeoDictionaryProduct,
	GeoDictionarySnapshot,
} from "@workspace/geo-domain";
import type { AliasHit } from "./alias-match";
import { rangeContaining, sentenceRanges, type TextRange, trimmedRange } from "./text";

export interface ExtractedClaim {
	kind: GeoClaimKind;
	/** The sentence the claim sits in, as the answer says it. */
	text: string;
	/** Where the stated value is, in the stored answer. */
	span: TextRange;
	value: string;
	/** Upper-case product model the sentence is about, or null when it is about the brand as a whole. */
	subject: string | null;
}

const UNIT_ALIASES: [RegExp, string][] = [
	[/^(kv|千伏)$/i, "kv"],
	[/^(ka|千安)$/i, "ka"],
	[/^(a|安|安培)$/i, "a"],
	[/^(kw|千瓦)$/i, "kw"],
	[/^kva$/i, "kva"],
	[/^mva$/i, "mva"],
	[/^hz$/i, "hz"],
	[/^(mm|毫米)$/i, "mm"],
	[/^(m|米)$/i, "m"],
	[/^(℃|°c)$/i, "c"],
	[/^(平方米|㎡|m2)$/i, "m2"],
];

const NUMBER_WITH_UNIT =
	/(\d+(?:\.\d+)?)\s*(kV|KV|kv|千伏|kA|KA|ka|千安|kVA|KVA|kva|MVA|mva|kW|KW|kw|千瓦|Hz|HZ|hz|mm|毫米|℃|°C|平方米|㎡|安培|万元|亿元|年|项|台|套|个|名|家|%|A|安|米|m)(?![A-Za-z])/g;

const CERTIFICATE =
	/\bISO\s?\d{4,5}(?::\d{4})?|\bIEC\s?\d{3,6}(?:-\d+)*|\bGB\/?T?\s?\d{3,6}(?:[.-]\d+)*|\bCCC\b|3C认证|\bCQC\b|\bCE认证|\bUL认证|\bKEMA\b/gi;

const MODEL_SHAPE = /\b[A-Z]{1,6}[A-Z0-9]*-?\d{1,4}[A-Z0-9-]*\b/g;

function canonicalUnit(unit: string): string {
	for (const [pattern, canonical] of UNIT_ALIASES) if (pattern.test(unit)) return canonical;
	return unit.toLowerCase();
}

function canonicalNumber(value: string): string {
	return String(Number(value));
}

export function numberFacts(text: string): { value: string; unit: string; start: number; end: number }[] {
	return [...text.matchAll(NUMBER_WITH_UNIT)].map((match) => {
		const unit = canonicalUnit(match[2] ?? "");
		return {
			value: `${canonicalNumber(match[1] ?? "0")}${unit}`,
			unit,
			start: match.index ?? 0,
			end: (match.index ?? 0) + match[0].length,
		};
	});
}

export function certificateFacts(text: string): { value: string; start: number; end: number }[] {
	return [...text.matchAll(CERTIFICATE)].map((match) => ({
		value: match[0].toUpperCase().replace(/\s+/g, "").replace(/认证$/, ""),
		start: match.index ?? 0,
		end: (match.index ?? 0) + match[0].length,
	}));
}

export function modelFacts(text: string): { value: string; start: number; end: number }[] {
	return [...text.matchAll(MODEL_SHAPE)].map((match) => ({
		value: match[0].toUpperCase(),
		start: match.index ?? 0,
		end: (match.index ?? 0) + match[0].length,
	}));
}

function ownProducts(dictionary: GeoDictionarySnapshot): GeoDictionaryProduct[] {
	const own = new Set(dictionary.entities.filter((entity) => entity.kind === "OWN").map((entity) => entity.id));
	return dictionary.products.filter((product) => product.status === "ACTIVE" && own.has(product.brandEntityId));
}

function occurrences(haystack: string, needle: string): number[] {
	const found: number[] = [];
	let at = haystack.indexOf(needle);
	while (at >= 0) {
		found.push(at);
		at = haystack.indexOf(needle, at + needle.length);
	}
	return found;
}

function productMentions(text: string, products: readonly GeoDictionaryProduct[]): { model: string; start: number }[] {
	const upper = text.toUpperCase();
	return products.flatMap((product) => {
		const model = (product.model ?? product.name).toUpperCase();
		const terms = [product.model, product.termKind === "CUSTOMER_MODEL" ? product.name : null].filter(
			(term): term is string => Boolean(term),
		);
		return terms.flatMap((term) => occurrences(upper, term.toUpperCase()).map((start) => ({ model, start })));
	});
}

interface SubjectSentence {
	range: TextRange;
	subject: string | null;
}

/** Sentences naming the brand (subject null) or one of its products (subject = that model). */
function subjectSentences(
	text: string,
	brandHits: readonly AliasHit[],
	dictionary: GeoDictionarySnapshot,
): SubjectSentence[] {
	const sentences = sentenceRanges(text);
	const subjects = new Map<number, SubjectSentence>();
	for (const hit of brandHits) {
		const range = rangeContaining(sentences, hit.start);
		if (range && !subjects.has(range.start)) subjects.set(range.start, { range, subject: null });
	}
	for (const mention of productMentions(text, ownProducts(dictionary))) {
		const range = rangeContaining(sentences, mention.start);
		if (range) subjects.set(range.start, { range, subject: mention.model });
	}
	return [...subjects.values()].sort((a, b) => a.range.start - b.range.start);
}

const STANDARD_PREFIX = /^(ISO|IEC|GB|CCC|CQC)/;

function claimsInSentence(text: string, { range, subject }: SubjectSentence): ExtractedClaim[] {
	const sentenceRange = trimmedRange(text, range);
	const sentence = text.slice(sentenceRange.start, sentenceRange.end);
	const shift = (fact: { start: number; end: number }) => ({
		start: sentenceRange.start + fact.start,
		end: sentenceRange.start + fact.end,
	});
	return [
		...numberFacts(sentence).map((fact) => ({
			kind: "NUMBER" as const,
			text: sentence,
			span: shift(fact),
			value: fact.value,
			subject,
		})),
		...certificateFacts(sentence).map((fact) => ({
			kind: "CERTIFICATE" as const,
			text: sentence,
			span: shift(fact),
			value: fact.value,
			subject,
		})),
		...modelFacts(sentence)
			.filter((fact) => !STANDARD_PREFIX.test(fact.value))
			.map((fact) => ({
				kind: "MODEL" as const,
				text: sentence,
				span: shift(fact),
				value: fact.value,
				subject: subject ?? fact.value,
			})),
	];
}

/**
 * Number, model and certificate statements in the sentences that talk about the brand
 * or one of its own products. Statements about competitors are not the brand's facts,
 * so they are not extracted.
 */
export function extractClaims(
	text: string,
	brandHits: readonly AliasHit[],
	dictionary: GeoDictionarySnapshot,
): ExtractedClaim[] {
	const seen = new Set<string>();
	return subjectSentences(text, brandHits, dictionary)
		.flatMap((sentence) => claimsInSentence(text, sentence))
		.filter((claim) => {
			const key = `${claim.kind}|${claim.subject ?? ""}|${claim.value}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});
}

export interface ApprovedAssertion {
	id: string;
	claimText: string;
	normalizedValue: unknown;
}

export interface CheckedClaim extends ExtractedClaim {
	matchStatus: GeoClaimMatchStatus;
	verdict: GeoClaimVerdict;
	assertionId: string | null;
	referenceValue: string | null;
}

function flatten(value: unknown): string[] {
	if (value === null || value === undefined) return [];
	if (Array.isArray(value)) return value.flatMap(flatten);
	if (typeof value === "object") return Object.values(value as Record<string, unknown>).flatMap(flatten);
	return [String(value)];
}

interface AssertionFacts {
	id: string;
	text: string;
	numbers: { value: string; unit: string }[];
	certificates: Set<string>;
	models: Set<string>;
}

function factsOf(assertion: ApprovedAssertion): AssertionFacts {
	const text = [assertion.claimText, ...flatten(assertion.normalizedValue)].join("\n");
	return {
		id: assertion.id,
		text: text.toUpperCase(),
		numbers: numberFacts(text),
		certificates: new Set(certificateFacts(text).map((fact) => fact.value)),
		models: new Set(modelFacts(text.toUpperCase()).map((fact) => fact.value)),
	};
}

function matched(claim: ExtractedClaim, assertionId: string | null, referenceValue: string): CheckedClaim {
	return { ...claim, matchStatus: "MATCHED", verdict: "CORRECT", assertionId, referenceValue };
}

function unreferenced(claim: ExtractedClaim): CheckedClaim {
	return { ...claim, matchStatus: "NO_REFERENCE", verdict: "UNVERIFIED", assertionId: null, referenceValue: null };
}

function checkNumber(claim: ExtractedClaim, facts: readonly AssertionFacts[]): CheckedClaim {
	const about = claim.subject ? facts.filter((fact) => fact.text.includes(claim.subject ?? "")) : facts;
	const unit = claim.value.replace(/^[\d.]+/, "");
	const sameUnit = about.flatMap((fact) =>
		fact.numbers.filter((number) => number.unit === unit).map((number) => ({ id: fact.id, value: number.value })),
	);
	const exact = sameUnit.find((number) => number.value === claim.value);
	if (exact) return matched(claim, exact.id, exact.value);
	if (sameUnit.length === 0) return unreferenced(claim);
	return {
		...claim,
		matchStatus: "MISMATCH",
		verdict: "UNVERIFIED",
		assertionId: sameUnit[0]?.id ?? null,
		referenceValue: [...new Set(sameUnit.map((number) => number.value))].join("、"),
	};
}

/**
 * Compares claims with approved knowledge. Agreement settles a claim as correct; a
 * disagreement only flags it, because the error rate counts errors a technical reviewer
 * confirmed, and a claim nothing approved speaks to stays unverified rather than wrong.
 */
export function checkClaims(
	claims: readonly ExtractedClaim[],
	assertions: readonly ApprovedAssertion[],
	dictionary: GeoDictionarySnapshot,
): CheckedClaim[] {
	const facts = assertions.map(factsOf);
	const knownModels = new Set(
		ownProducts(dictionary)
			.map((product) => product.model?.toUpperCase())
			.filter((model): model is string => Boolean(model)),
	);
	return claims.map((claim) => {
		if (claim.kind === "MODEL") {
			const assertion = facts.find((fact) => fact.models.has(claim.value));
			return knownModels.has(claim.value) || assertion
				? matched(claim, assertion?.id ?? null, claim.value)
				: unreferenced(claim);
		}
		if (claim.kind === "CERTIFICATE") {
			const assertion = facts.find((fact) => fact.certificates.has(claim.value));
			return assertion ? matched(claim, assertion.id, claim.value) : unreferenced(claim);
		}
		return checkNumber(claim, facts);
	});
}
