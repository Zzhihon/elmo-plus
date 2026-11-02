/** Full-width forms folded, whitespace collapsed: two spellings of one model number compare equal. */
export function normalizeValueText(value: string): string {
	return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

export function canonicalKeyOf(value: string): string {
	return value
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[\s\p{P}\p{S}]+/gu, "")
		.slice(0, 200);
}

const CJK = /[㐀-鿿豈-﫿]/;

/**
 * CJK runs become overlapping bigrams and other runs lower-cased tokens, so the
 * `simple` text-search configuration can match Chinese without an extension.
 */
export function searchTokensOf(text: string): string {
	const tokens = new Set<string>();
	const normalized = text.normalize("NFKC").toLowerCase();
	for (const run of normalized.match(/[㐀-鿿豈-﫿]+|[a-z0-9]+(?:[.-][a-z0-9]+)*/g) ?? []) {
		if (CJK.test(run[0])) {
			if (run.length === 1) tokens.add(run);
			for (let index = 0; index < run.length - 1; index++) tokens.add(run.slice(index, index + 2));
		} else {
			tokens.add(run);
		}
		if (tokens.size >= 4000) break;
	}
	return [...tokens].join(" ");
}

const DATE = /(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})/;

export function normalizeDate(value: string): string | null {
	const match = DATE.exec(value.normalize("NFKC"));
	if (!match) return null;
	const [, year, month, day] = match;
	const monthNumber = Number(month);
	const dayNumber = Number(day);
	if (monthNumber < 1 || monthNumber > 12 || dayNumber < 1 || dayNumber > 31) return null;
	return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

export function truncate(value: string, max: number): string {
	return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
