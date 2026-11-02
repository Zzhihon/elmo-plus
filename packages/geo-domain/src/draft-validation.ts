import type { GeoRiskLevel } from "./enums";

/**
 * Deterministic fact check of a draft against the approved facts it was given.
 * Numbers, model numbers, standards and certificate names are pulled out of each
 * sentence and looked up in the facts that sentence cites with `[F<n>]`.
 */

export interface GeoDraftFact {
	ref: string;
	assertionId: string;
	claimText: string;
	normalizedValue: unknown;
	entityTitle: string | null;
	riskLevel: GeoRiskLevel;
}

export type GeoDraftTokenKind = "NUMBER" | "MODEL" | "STANDARD" | "CERTIFICATE";
export type GeoDraftCheckStatus = "SUPPORTED" | "UNCITED" | "UNSUPPORTED" | "MISMATCH";

export interface GeoDraftCheck {
	token: string;
	kind: GeoDraftTokenKind;
	risk: GeoRiskLevel;
	status: GeoDraftCheckStatus;
	segment: number;
	excerpt: string;
	citedRefs: string[];
	supportingRefs: string[];
}

export interface GeoDraftValidation {
	checks: GeoDraftCheck[];
	/** Markers that name no fact in the set: a citation the draft made up. */
	unknownRefs: string[];
	citedRefs: string[];
	blocking: boolean;
	blockingCount: number;
	/** Claims shown as “待证实”: no source found, or a source exists but the sentence does not cite it. */
	pendingCount: number;
}

interface Token {
	kind: GeoDraftTokenKind;
	raw: string;
	norm: string;
	risk: GeoRiskLevel;
	value?: number;
	unit?: string | null;
	family?: string;
	year?: string | null;
}

const MARKER = /\[(F\d+(?:\s*[,，、]\s*F\d+)*)\]/g;
const STANDARD = /(?:GB\/T|GB\/Z|GB|DL\/T|JB\/T|NB\/T|IEC|ISO|IEEE|EN|UL)\s?\d+(?:[.\-—]\d+)*/g;
const IP_RATING = /IP\d{2}(?![0-9])/g;
const MODEL =
	/(?<![A-Za-z0-9])(?:[A-Z]{1,6}\d+[A-Z0-9]*(?:[-/][A-Z0-9.]+)*|[A-Z]{2,6}(?:[-/][A-Z0-9.]*\d[A-Z0-9.]*)+)/g;
const NUMBER =
	/(?<![\d.])(\d+(?:,\d{3})*(?:\.\d+)?)\s*(kVA|MVA|kV|kA|kW|MW|Hz|mm|cm|kg|℃|°C|%|万元|亿元|千伏|毫米|元|V|A|m|t|级|项|台|套|个|年|家|人|吨|米)?/g;
const CERTIFICATE = /[\p{Script=Han}A-Za-z0-9]{2,16}?(?:证书|认证|许可证)/gu;
const CERTIFICATE_LEADS = ["通过", "获得", "取得", "拥有", "具备", "持有", "荣获", "并获", "已获"];

/** "本公司产品均通过国家强制性产品认证" names the certificate after the last verb. */
function certificateCore(phrase: string): string {
	let start = 0;
	for (const lead of CERTIFICATE_LEADS) {
		const at = phrase.lastIndexOf(lead);
		if (at >= 0) start = Math.max(start, at + lead.length);
	}
	return phrase.slice(start).replace(/^了/, "");
}

const HIGH_UNITS = new Set([
	"kva",
	"mva",
	"kv",
	"ka",
	"kw",
	"mw",
	"hz",
	"mm",
	"cm",
	"kg",
	"c",
	"%",
	"万元",
	"亿元",
	"元",
	"v",
	"a",
	"m",
	"t",
	"级",
	"项",
	"ip",
]);
const UNIT_ALIASES: Record<string, string> = { 千伏: "kv", 毫米: "mm", 米: "m", 吨: "t", "℃": "c", "°c": "c" };
const HIGH_CONTEXT = /专利|注册资本|资本金|额定|电压|电流|容量|频率|防护等级/;

function normText(value: string): string {
	return value
		.normalize("NFKC")
		.toUpperCase()
		.replace(/[—–－]/g, "-")
		.replace(/\s+/g, "");
}

function unitOf(raw: string | undefined): string | null {
	if (!raw) return null;
	const lower = raw.normalize("NFKC").toLowerCase();
	return UNIT_ALIASES[lower] ?? UNIT_ALIASES[raw] ?? lower;
}

function blank(text: string, start: number, length: number): string {
	return text.slice(0, start) + " ".repeat(length) + text.slice(start + length);
}

function takeAll(text: string, pattern: RegExp, build: (match: RegExpExecArray) => Token | null) {
	const tokens: Token[] = [];
	let rest = text;
	for (const match of text.matchAll(pattern)) {
		const token = build(match as RegExpExecArray);
		if (!token) continue;
		tokens.push(token);
		rest = blank(rest, match.index ?? 0, match[0].length);
	}
	return { tokens, rest };
}

function standardToken(raw: string): Token {
	const norm = normText(raw);
	const dated = /^(.*)-(\d{4})$/.exec(norm);
	return { kind: "STANDARD", raw, norm, risk: "HIGH", family: dated?.[1] ?? norm, year: dated?.[2] ?? null };
}

function numberToken(match: RegExpExecArray, context: string): Token | null {
	const [whole, digits, rawUnit] = match;
	const after = context.charAt((match.index ?? 0) + whole.length);
	// "12 months" is a bare 12, not 12 metres.
	const unit = rawUnit && /^[A-Za-z]+$/.test(rawUnit) && /[A-Za-z]/.test(after) ? null : unitOf(rawUnit);
	const value = Number(digits.replace(/,/g, ""));
	if (!Number.isFinite(value)) return null;
	const raw = unit ? `${digits}${rawUnit}` : digits;
	const risk: GeoRiskLevel = (unit && HIGH_UNITS.has(unit)) || HIGH_CONTEXT.test(context) ? "HIGH" : "NORMAL";
	return { kind: "NUMBER", raw, norm: `${value}${unit ?? ""}`, risk, value, unit };
}

function tokenize(input: string): Token[] {
	let text = input.normalize("NFKC");
	const standards = takeAll(text, STANDARD, (match) => standardToken(match[0]));
	text = standards.rest;
	const ratings = takeAll(text, IP_RATING, (match) => ({
		kind: "NUMBER",
		raw: match[0],
		norm: match[0].toUpperCase(),
		risk: "HIGH",
		value: Number(match[0].slice(2)),
		unit: "ip",
	}));
	text = ratings.rest;
	const models = takeAll(text, MODEL, (match) => {
		const raw = match[0].replace(/[.]+$/, "");
		if (raw.length < 3) return null;
		return { kind: "MODEL", raw, norm: normText(raw), risk: "HIGH", family: /^[A-Z]+/.exec(raw)?.[0] ?? raw };
	});
	text = models.rest;
	const certificates: Token[] = [];
	for (const match of input.normalize("NFKC").matchAll(CERTIFICATE)) {
		const core = certificateCore(match[0]);
		if (core.length < 4) continue;
		certificates.push({ kind: "CERTIFICATE", raw: core, norm: normText(core), risk: "NORMAL" });
	}
	const numbers: Token[] = [];
	for (const match of text.matchAll(NUMBER)) {
		const token = numberToken(match as RegExpExecArray, text);
		if (token) numbers.push(token);
	}
	return [...standards.tokens, ...ratings.tokens, ...models.tokens, ...certificates, ...numbers];
}

function cleanSegment(segment: string): string {
	return segment
		.replace(MARKER, " ")
		.replace(/\]\((?:https?:\/\/)[^)]*\)/g, "]")
		.replace(/https?:\/\/\S+/g, " ")
		.replace(/^\s*#{1,6}\s+/, "")
		.replace(/^\s*(?:\d+[.)、]|[-*+])\s+/, "")
		.replace(/[*_`]/g, "");
}

function refsIn(segment: string): string[] {
	const refs: string[] = [];
	for (const match of segment.matchAll(MARKER)) {
		for (const ref of match[1].split(/\s*[,，、]\s*/)) refs.push(ref.trim());
	}
	return refs;
}

/** A marker written after the full stop still belongs to the sentence before it. */
function segmentsOf(body: string): { text: string; refs: string[] }[] {
	const moved = body.replace(/([。！？；!?;])((?:\s*\[F\d+(?:\s*[,，、]\s*F\d+)*\])+)/g, "$2$1");
	return moved
		.split(/(?<=[。！？；!?;])|\n/)
		.map((part) => ({ text: cleanSegment(part).trim(), refs: refsIn(part) }))
		.filter((part) => part.text.length > 0 || part.refs.length > 0);
}

interface IndexedFact {
	ref: string;
	norm: string;
	tokens: Token[];
}

function flatten(value: unknown): string[] {
	if (value === null || value === undefined) return [];
	if (typeof value === "string" || typeof value === "number") return [String(value)];
	if (Array.isArray(value)) return value.flatMap(flatten);
	if (typeof value === "object") return Object.values(value as Record<string, unknown>).flatMap(flatten);
	return [];
}

function indexFact(fact: GeoDraftFact): IndexedFact {
	const text = [fact.entityTitle ?? "", fact.claimText, ...flatten(fact.normalizedValue)].join("\n");
	return { ref: fact.ref, norm: normText(text), tokens: tokenize(text) };
}

function supports(fact: IndexedFact, token: Token): boolean {
	switch (token.kind) {
		case "NUMBER":
			return fact.tokens.some(
				(other) =>
					other.kind === "NUMBER" &&
					other.value === token.value &&
					(!token.unit || !other.unit || other.unit === token.unit),
			);
		case "MODEL":
		case "STANDARD":
		case "CERTIFICATE":
			return fact.norm.includes(token.norm);
	}
}

function contradicts(fact: IndexedFact, token: Token): boolean {
	switch (token.kind) {
		case "NUMBER":
			return (
				Boolean(token.unit) &&
				fact.tokens.some((other) => other.kind === "NUMBER" && other.unit === token.unit && other.value !== token.value)
			);
		case "MODEL":
			return fact.tokens.some(
				(other) => other.kind === "MODEL" && other.family === token.family && other.norm !== token.norm,
			);
		case "STANDARD":
			return fact.tokens.some(
				(other) =>
					other.kind === "STANDARD" &&
					other.family === token.family &&
					Boolean(token.year) &&
					other.year !== token.year,
			);
		case "CERTIFICATE":
			return false;
	}
}

function excerptOf(text: string): string {
	return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}

function checkToken(
	token: Token,
	cited: readonly IndexedFact[],
	all: readonly IndexedFact[],
): { status: GeoDraftCheckStatus; supportingRefs: string[] } {
	const direct = cited.filter((fact) => supports(fact, token)).map((fact) => fact.ref);
	if (direct.length > 0) return { status: "SUPPORTED", supportingRefs: direct };
	const anywhere = all.filter((fact) => supports(fact, token)).map((fact) => fact.ref);
	if (cited.some((fact) => contradicts(fact, token))) return { status: "MISMATCH", supportingRefs: anywhere };
	return { status: anywhere.length > 0 ? "UNCITED" : "UNSUPPORTED", supportingRefs: anywhere };
}

function checkSegment(
	segment: { text: string; refs: string[] },
	index: number,
	cited: readonly IndexedFact[],
	all: readonly IndexedFact[],
): GeoDraftCheck[] {
	const seen = new Set<string>();
	const checks: GeoDraftCheck[] = [];
	for (const token of tokenize(segment.text)) {
		const key = `${token.kind}:${token.norm}`;
		if (seen.has(key)) continue;
		seen.add(key);
		checks.push({
			token: token.raw,
			kind: token.kind,
			risk: token.risk,
			...checkToken(token, cited, all),
			segment: index,
			excerpt: excerptOf(segment.text),
			citedRefs: segment.refs,
		});
	}
	return checks;
}

export function validateDraft(body: string, facts: readonly GeoDraftFact[]): GeoDraftValidation {
	const indexed = new Map(facts.map((fact) => [fact.ref, indexFact(fact)]));
	const all = [...indexed.values()];
	const checks: GeoDraftCheck[] = [];
	const unknown = new Set<string>();
	const cited = new Set<string>();

	segmentsOf(body).forEach((segment, index) => {
		const citedFacts = segment.refs.flatMap((ref) => {
			const fact = indexed.get(ref);
			(fact ? cited : unknown).add(ref);
			return fact ? [fact] : [];
		});
		checks.push(...checkSegment(segment, index, citedFacts, all));
	});

	const blockingCount =
		checks.filter((check) => check.risk === "HIGH" && (check.status === "UNSUPPORTED" || check.status === "MISMATCH"))
			.length + unknown.size;
	const pendingCount = checks.filter((check) => check.status === "UNCITED" || check.status === "UNSUPPORTED").length;
	return {
		checks,
		unknownRefs: [...unknown].sort(),
		citedRefs: [...cited].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))),
		blocking: blockingCount > 0,
		blockingCount,
		pendingCount,
	};
}
