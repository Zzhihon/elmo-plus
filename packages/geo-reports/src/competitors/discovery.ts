import { type GeoPlatform, normalizeBrandDomain, normalizeBrandTerm } from "@workspace/geo-domain";
import { z } from "zod";

export const competitorExtractionSchema = z.object({
	answers: z.array(
		z.object({
			index: z.number().int().min(0),
			companies: z
				.array(z.object({ name: z.string().min(2).max(100), domain: z.string().max(253).nullable() }))
				.max(40),
		}),
	),
});
export type CompetitorExtraction = z.infer<typeof competitorExtractionSchema>;

/** Only the answer text goes out: no question, no dictionary, nothing from the knowledge base. */
export function buildCompetitorExtractionPrompt(answers: readonly { index: number; text: string }[]): string {
	return [
		"下面是几条 AI 助手对电力设备采购问题的回答。请逐条找出回答中点名提到的公司或品牌，只要电气设备、开关柜、配电柜、成套设备、变压器等电力行业的厂家或供应商。",
		"规则：",
		"- name 必须是回答原文中逐字出现的写法，不要补全、翻译或改写。",
		"- 不要列出平台、网站、行业协会、政府机构、设计院、业主单位或泛称（如“本地厂家”“国内品牌”）。",
		"- 同一条回答里同一家公司只列一次；没有则返回空数组。",
		"- domain 仅在原文给出该公司网址时填写，否则为 null。",
		"- index 填写回答编号。",
		"",
		...answers.flatMap((answer) => [`【回答 ${answer.index}】`, answer.text, ""]),
	].join("\n");
}

export interface CompetitorAnswer {
	id: string;
	platform: GeoPlatform;
	text: string;
	sampledAt: Date;
}

export interface CompetitorTally {
	normalizedName: string;
	name: string;
	aliases: string[];
	domains: string[];
	mentionCount: number;
	observationIds: string[];
	platforms: GeoPlatform[];
	lastSeenAt: Date;
}

function countOccurrences(haystack: string, needle: string): number {
	let count = 0;
	for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + needle.length)) count += 1;
	return count;
}

/** A name that contains a known brand term, or sits inside one, is that brand under another spelling. */
function isKnownBrand(key: string, known: readonly string[]): boolean {
	return known.some((term) => term.length >= 2 && (key.includes(term) || term.includes(key)));
}

function mergeMention(
	tallies: Map<string, CompetitorTally>,
	key: string,
	company: { name: string; domain: string | null },
	answer: CompetitorAnswer,
	mentions: number,
) {
	const tally = tallies.get(key) ?? {
		normalizedName: key,
		name: company.name,
		aliases: [],
		domains: [],
		mentionCount: 0,
		observationIds: [],
		platforms: [],
		lastSeenAt: answer.sampledAt,
	};
	if (tally.observationIds.includes(answer.id)) return;
	if (company.name !== tally.name && !tally.aliases.includes(company.name)) tally.aliases.push(company.name);
	const domain = company.domain ? normalizeBrandDomain(company.domain) : null;
	if (domain && !tally.domains.includes(domain)) tally.domains.push(domain);
	tally.mentionCount += mentions;
	tally.observationIds.push(answer.id);
	if (!tally.platforms.includes(answer.platform)) tally.platforms.push(answer.platform);
	if (answer.sampledAt > tally.lastSeenAt) tally.lastSeenAt = answer.sampledAt;
	tallies.set(key, tally);
}

/**
 * Adds what the model found in one group of answers. A name the answer does not contain
 * is dropped as unsupported, and the organization's own brand and its known competitors,
 * under any of their names, never become candidates.
 */
export function tallyCompetitorMentions(
	tallies: Map<string, CompetitorTally>,
	answers: readonly CompetitorAnswer[],
	extraction: CompetitorExtraction,
	knownBrandTerms: readonly string[],
): void {
	const known = knownBrandTerms.map(normalizeBrandTerm).filter(Boolean);
	for (const found of extraction.answers) {
		const answer = answers[found.index];
		if (!answer) continue;
		const text = normalizeBrandTerm(answer.text);
		for (const company of found.companies) {
			const name = company.name.trim();
			const key = normalizeBrandTerm(name);
			if (key.length < 2 || !text.includes(key) || isKnownBrand(key, known)) continue;
			mergeMention(tallies, key, { name, domain: company.domain }, answer, countOccurrences(text, key));
		}
	}
}
