import type { GeoRiskLevel } from "@workspace/geo-domain";
import type {
	AssertionCandidate,
	ContentNormalizer,
	EntityCandidate,
	EntityFieldValue,
	KnowledgeMapper,
	ParsedPage,
} from "./contracts";
import type { SiteProfile } from "./profile";
import { canonicalKeyOf, normalizeValueText, truncate } from "./text";

/**
 * PRD 3.12: technical parameters, certificates, standards, patent counts and
 * delivery results need a technical or marketing owner holding the original.
 */
const HIGH_RISK_CLAIM_TYPES = new Set([
	"TECH_PARAMETER",
	"STANDARD",
	"CERTIFICATE",
	"QUALIFICATION",
	"PATENT",
	"PROJECT_RESULT",
	"PERFORMANCE",
]);

/** A number with an electrical, physical or count unit reads as a specification. */
const SPEC_VALUE = /\d+(\.\d+)?\s*(k?v|ka|a|hz|kva|kw|mw|mva|mm|cm|m|kg|t|℃|°c|%|级|项|台|套|年|ip\d{2})(?![a-z])/i;

const KEY_FIELDS = ["model", "name", "code"];
const MAX_CLAIM = 2000;

function valueText(value: EntityFieldValue["value"]): string {
	if (typeof value === "string") return normalizeValueText(value);
	if (value.length > 0 && Array.isArray(value[0])) {
		return (value as string[][]).map((row) => row.map(normalizeValueText).join(" | ")).join("\n");
	}
	return (value as string[]).map(normalizeValueText).join("；");
}

function normalizedValueOf(value: EntityFieldValue["value"]): unknown {
	if (typeof value === "string") return normalizeValueText(value);
	if (value.length > 0 && Array.isArray(value[0])) return (value as string[][]).map((row) => row.map(normalizeValueText));
	return (value as string[]).map(normalizeValueText);
}

function matchesFieldPattern(path: string, pattern: string): boolean {
	const expression = pattern
		.split(".")
		.map((segment) => (segment === "*" ? "[^.]+" : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
		.join("\\.");
	return new RegExp(`^${expression}$`).test(path);
}

export function riskOf(field: EntityFieldValue, profile: Pick<SiteProfile, "highRiskFields">): GeoRiskLevel {
	if (field.risk) return field.risk;
	if (profile.highRiskFields.some((pattern) => matchesFieldPattern(field.path, pattern))) return "HIGH";
	if (field.claimType && HIGH_RISK_CLAIM_TYPES.has(field.claimType)) return "HIGH";
	return SPEC_VALUE.test(valueText(field.value)) ? "HIGH" : "NORMAL";
}

export const siteContentNormalizer: ContentNormalizer = {
	normalize(page: ParsedPage): EntityCandidate[] {
		if (!page.entityKind || page.role === "listing") return [];
		const fields: EntityFieldValue[] = page.fields
			.filter((field) => field.value !== null && (!Array.isArray(field.value) || field.value.length > 0))
			.map((field) => ({
				path: field.path,
				label: field.label,
				value: field.value as EntityFieldValue["value"],
				locator: field.locator,
				claimType: field.claimType,
				risk: field.risk,
			}));
		const keyField = KEY_FIELDS.map((path) => fields.find((field) => field.path === path)).find(
			(field) => field && typeof field.value === "string",
		);
		const title = normalizeValueText((keyField?.value as string | undefined) ?? page.title ?? "");
		if (!title) return [];
		const canonicalKey = page.entityKind === "COMPANY" ? "company" : canonicalKeyOf(title);
		if (!canonicalKey) return [];
		return [
			{
				kind: page.entityKind,
				canonicalKey,
				title: truncate(title, 300),
				attributes: {
					url: page.url,
					category: page.category,
					categoryLabel: page.categoryLabel,
					publishedAt: page.publishedAt,
					images: page.images.slice(0, 20).map((image) => image.src),
					excerpt: truncate(page.text, 500),
				},
				fields,
			},
		];
	},
};

export const siteKnowledgeMapper: KnowledgeMapper = {
	map(entity: EntityCandidate, profile: SiteProfile): AssertionCandidate[] {
		return entity.fields
			.filter((field) => field.claimType)
			.map((field) => {
				const text = valueText(field.value);
				return {
					claimType: field.claimType as string,
					fieldPath: field.path,
					claimText: truncate(`${entity.title}｜${field.label ?? field.path}：${text}`, MAX_CLAIM),
					normalizedValue: normalizedValueOf(field.value),
					riskLevel: riskOf(field, profile),
					locator: field.locator,
				};
			})
			.filter((candidate) => candidate.claimText.length > 0);
	},
};
