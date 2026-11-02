/**
 * Answer text normalised for matching (NFKC, lower case, runs of whitespace as one
 * space), with every normalised unit mapped back to where it came from, so a match
 * found in the normalised form can be quoted from the stored answer exactly.
 */
export interface MatchText {
	text: string;
	starts: number[];
	ends: number[];
}

export function toMatchText(input: string): MatchText {
	let text = "";
	const starts: number[] = [];
	const ends: number[] = [];
	let index = 0;
	let lastWasSpace = false;
	for (const char of input) {
		const start = index;
		index += char.length;
		if (/\s/u.test(char)) {
			if (lastWasSpace || text.length === 0) continue;
			lastWasSpace = true;
			text += " ";
			starts.push(start);
			ends.push(index);
			continue;
		}
		lastWasSpace = false;
		const folded = char.normalize("NFKC").toLowerCase();
		for (let unit = 0; unit < folded.length; unit++) {
			text += folded[unit];
			starts.push(start);
			ends.push(index);
		}
	}
	return { text, starts, ends };
}

/** Converts a half-open range in the normalised text back to the stored answer. */
export function originalRange(match: MatchText, start: number, end: number): { start: number; end: number } {
	return { start: match.starts[start] ?? 0, end: match.ends[end - 1] ?? 0 };
}

export function isHan(char: string | undefined): boolean {
	return char !== undefined && /\p{Script=Han}/u.test(char);
}

export function isAsciiWordChar(char: string | undefined): boolean {
	return char !== undefined && /[a-z0-9]/.test(char);
}

export interface TextRange {
	start: number;
	end: number;
}

const SENTENCE_END = /[。！？!?；;\n]/u;

/** Sentence ranges over the stored answer; a list item on its own line counts as one sentence. */
export function sentenceRanges(text: string): TextRange[] {
	const ranges: TextRange[] = [];
	let start = 0;
	for (let index = 0; index < text.length; index++) {
		if (SENTENCE_END.test(text[index] ?? "")) {
			if (index + 1 > start) ranges.push({ start, end: index + 1 });
			start = index + 1;
		}
	}
	if (start < text.length) ranges.push({ start, end: text.length });
	return ranges.filter((range) => text.slice(range.start, range.end).trim().length > 0);
}

export function rangeContaining(ranges: readonly TextRange[], position: number): TextRange | null {
	return ranges.find((range) => position >= range.start && position < range.end) ?? null;
}

export function trimmedRange(text: string, range: TextRange): TextRange {
	let { start, end } = range;
	while (start < end && /\s/u.test(text[start] ?? "")) start++;
	while (end > start && /[\s。！？!?；;]/u.test(text[end - 1] ?? "")) end--;
	return { start, end };
}
