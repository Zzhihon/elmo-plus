import type { TextRange } from "./text";

export interface ListItem {
	number: number;
	/** The item's first line: where a ranked answer names what it ranks. */
	head: TextRange;
}

export interface OrderedList {
	items: ListItem[];
	start: number;
}

const CHINESE_DIGITS: Record<string, number> = {
	一: 1,
	二: 2,
	三: 3,
	四: 4,
	五: 5,
	六: 6,
	七: 7,
	八: 8,
	九: 9,
	十: 10,
};

function chineseNumber(value: string): number | null {
	if (value === "十") return 10;
	if (value.length === 1) return CHINESE_DIGITS[value] ?? null;
	if (value.length === 2 && value[0] === "十") return 10 + (CHINESE_DIGITS[value[1] ?? ""] ?? 0);
	if (value.length === 2 && value[1] === "十") return (CHINESE_DIGITS[value[0] ?? ""] ?? 0) * 10;
	return null;
}

const LEAD = String.raw`^[ \t>]*(?:#{1,6}[ \t]*)?(?:[-*+][ \t]+)?(?:\*\*|__)?[ \t]*`;
const MARKERS: { style: string; pattern: RegExp; parse: (match: RegExpExecArray) => number | null }[] = [
	{ style: "arabic", pattern: new RegExp(`${LEAD}(\\d{1,2})[ \\t]*[.、．:：](?!\\d)`), parse: (m) => Number(m[1]) },
	{ style: "paren", pattern: new RegExp(`${LEAD}[（(](\\d{1,2})[)）]`), parse: (m) => Number(m[1]) },
	{ style: "closing", pattern: new RegExp(`${LEAD}(\\d{1,2})[)）]`), parse: (m) => Number(m[1]) },
	{
		style: "circled",
		pattern: new RegExp(`${LEAD}([\\u2460-\\u2473])`),
		parse: (m) => (m[1]?.codePointAt(0) ?? 0x245f) - 0x245f,
	},
	{
		style: "ordinal",
		pattern: new RegExp(`${LEAD}第([一二三四五六七八九十]{1,2})[名位个家、:：.]?`),
		parse: (m) => chineseNumber(m[1] ?? ""),
	},
	{
		style: "chinese",
		pattern: new RegExp(`${LEAD}([一二三四五六七八九十]{1,2})[、.．]`),
		parse: (m) => chineseNumber(m[1] ?? ""),
	},
];

interface MarkedLine {
	style: string;
	indent: number;
	number: number;
	head: TextRange;
}

function markedLines(text: string): MarkedLine[] {
	const lines: MarkedLine[] = [];
	let offset = 0;
	for (const line of text.split("\n")) {
		for (const marker of MARKERS) {
			const match = marker.pattern.exec(line);
			const number = match ? marker.parse(match) : null;
			if (number !== null && number > 0) {
				const indent = line.length - line.trimStart().length;
				lines.push({ style: marker.style, indent, number, head: { start: offset, end: offset + line.length } });
				break;
			}
		}
		offset += line.length + 1;
	}
	return lines;
}

/**
 * Numbered lists of two or more items counting up from one. Items of another marker
 * style or indentation (a nested list, say) do not break the list they sit inside.
 */
export function findOrderedLists(text: string): OrderedList[] {
	const lists: OrderedList[] = [];
	const open = new Map<string, OrderedList>();
	for (const line of markedLines(text)) {
		const key = `${line.style}:${line.indent}`;
		const current = open.get(key);
		const last = current?.items.at(-1);
		if (current && last && line.number === last.number + 1) {
			current.items.push({ number: line.number, head: line.head });
			continue;
		}
		if (current && current.items.length >= 2) lists.push(current);
		open.delete(key);
		if (line.number === 1) open.set(key, { items: [{ number: 1, head: line.head }], start: line.head.start });
	}
	for (const list of open.values()) if (list.items.length >= 2) lists.push(list);
	return lists.sort((a, b) => a.start - b.start);
}

/** One-based position of the first item whose head contains `position`. */
export function rankAt(list: OrderedList, position: number): number | null {
	const index = list.items.findIndex((item) => position >= item.head.start && position < item.head.end);
	return index < 0 ? null : index + 1;
}
