import type { GeoPromptStatus } from "@workspace/geo-domain";
import { comparable } from "./rules";

export interface PromptCandidate {
	id: string;
	question: string;
	productLine: string | null;
	status: GeoPromptStatus;
}

/** What a page is about, as far as matching it to buyer questions goes. */
export interface PromptSubject {
	title: string | null;
	categoryLabel: string | null;
	/** Parsed field values such as product name and model. */
	terms: string[];
}

function bigrams(value: string): Set<string> {
	const cjk = [...value].filter((char) => /\p{Script=Han}/u.test(char));
	const grams = new Set<string>();
	for (let index = 0; index < cjk.length - 1; index++) grams.add(cjk[index] + cjk[index + 1]);
	return grams;
}

/** Model-like tokens (letters with digits, or short upper-case series names) that pin a question to a product. */
function modelTokens(value: string): string[] {
	return (value.match(/[A-Za-z][A-Za-z0-9-]*\d[A-Za-z0-9-]*|\b[A-Z]{2,6}\b/g) ?? []).map((token) =>
		token.toLowerCase(),
	);
}

function scoreOf(prompt: PromptCandidate, subject: PromptSubject): number {
	const haystack = [subject.title, subject.categoryLabel, ...subject.terms].filter(Boolean).join(" ");
	const question = prompt.question.toLowerCase();
	let score = 0;
	const productLine = prompt.productLine ? comparable(prompt.productLine) : "";
	const category = subject.categoryLabel ? comparable(subject.categoryLabel) : "";
	if (productLine && (comparable(haystack).includes(productLine) || (category && productLine.includes(category)))) {
		score += 3;
	}
	if (modelTokens(haystack).some((token) => question.includes(token))) score += 3;
	const subjectGrams = bigrams(`${subject.title ?? ""}${subject.terms.join("")}`);
	const shared = [...bigrams(prompt.question)].filter((gram) => subjectGrams.has(gram)).length;
	score += Math.min(shared / 2, 2);
	if (prompt.status === "BASELINE" || prompt.status === "FROZEN") score += 0.5;
	return score;
}

/**
 * Suggests the buyer questions a page fix is most likely to matter for, by
 * product line, model and wording. A person can change the choice; this only
 * fills it in when a finding is first raised.
 */
export function recommendTargetPrompts(
	subject: PromptSubject | null,
	prompts: readonly PromptCandidate[],
	limit = 3,
): string[] {
	if (!subject) return [];
	return prompts
		.filter((prompt) => prompt.status !== "REJECTED")
		.map((prompt) => ({ id: prompt.id, score: scoreOf(prompt, subject) }))
		.filter((entry) => entry.score >= 2.5)
		.sort((a, b) => b.score - a.score)
		.slice(0, limit)
		.map((entry) => entry.id);
}
