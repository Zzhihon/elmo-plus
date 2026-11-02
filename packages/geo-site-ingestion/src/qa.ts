import { createHash } from "node:crypto";
import type { GeoSiteQaVerdict } from "@workspace/geo-domain";

/** PRD 3.11: at least 30 pages, or every page when there are fewer. */
export const QA_MIN_SAMPLE = 30;
export const QA_ACCURACY_TARGET = 0.9;

/** The core fields every sampled page is labelled on, before any profile-specific ones. */
export const QA_CORE_FIELDS = ["title", "category", "publishedAt", "text", "images"] as const;

/**
 * A reproducible random draw: hashing each id with the seed and taking the
 * smallest hashes gives the same sample for the same seed and population, so a
 * sample can be audited after the fact.
 */
export function drawSample<T extends { id: string }>(population: readonly T[], size: number, seed: string): T[] {
	if (population.length <= size) return [...population];
	return population
		.map((item) => ({ item, rank: createHash("sha256").update(`${seed}:${item.id}`).digest("hex") }))
		.sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0))
		.slice(0, size)
		.map(({ item }) => item);
}

export function sampleSizeFor(population: number, requested?: number): number {
	return Math.min(population, Math.max(QA_MIN_SAMPLE, requested ?? QA_MIN_SAMPLE));
}

export interface QaAccuracy {
	labelled: number;
	correct: number;
	incorrect: number;
	notApplicable: number;
	pending: number;
	/** Correct over correct plus incorrect; null until something is labelled. */
	accuracy: number | null;
}

export function accuracyOf(verdicts: ReadonlyArray<GeoSiteQaVerdict | null>): QaAccuracy {
	const correct = verdicts.filter((verdict) => verdict === "CORRECT").length;
	const incorrect = verdicts.filter((verdict) => verdict === "INCORRECT").length;
	const notApplicable = verdicts.filter((verdict) => verdict === "NOT_APPLICABLE").length;
	const pending = verdicts.filter((verdict) => verdict === null).length;
	const judged = correct + incorrect;
	return {
		labelled: judged + notApplicable,
		correct,
		incorrect,
		notApplicable,
		pending,
		accuracy: judged === 0 ? null : correct / judged,
	};
}

export function accuracyByField(
	items: ReadonlyArray<{ fieldPath: string; verdict: GeoSiteQaVerdict | null }>,
): Record<string, QaAccuracy> {
	const groups = new Map<string, Array<GeoSiteQaVerdict | null>>();
	for (const item of items) {
		const list = groups.get(item.fieldPath) ?? [];
		list.push(item.verdict);
		groups.set(item.fieldPath, list);
	}
	return Object.fromEntries([...groups].map(([field, verdicts]) => [field, accuracyOf(verdicts)]));
}

/** Share of the confirmed URLs that exist as active pages with a parsed version. */
export function keyUrlCoverage(
	keyUrls: readonly string[],
	covered: ReadonlySet<string>,
): { total: number; covered: number; ratio: number | null; missing: string[] } {
	const unique = [...new Set(keyUrls)];
	const missing = unique.filter((url) => !covered.has(url));
	return {
		total: unique.length,
		covered: unique.length - missing.length,
		ratio: unique.length === 0 ? null : (unique.length - missing.length) / unique.length,
		missing,
	};
}
