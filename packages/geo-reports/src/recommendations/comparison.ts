import type { GeoCitedContentType, GeoPlatform, GeoSurfaceMode } from "@workspace/geo-domain";
import { type CompetitorRef, evaluatedValidSamples, groupByCell, type MetricSample } from "../metrics";
import type { RecommendationCitation } from "./generate";

export interface BrandPlatformFigure {
	platform: GeoPlatform;
	evaluated: number;
	mentioned: number;
}

export interface BrandComparisonRow {
	/** Null for the organization's own brand. */
	entityId: string | null;
	name: string;
	byPlatform: BrandPlatformFigure[];
	/** Equal-weight mean of the platform rates in this surface mode; null without data. */
	mentionRate: number | null;
	/** Distinct cited pages by type, in answers that name this brand: its own pages and third-party ones. */
	citedTypes: Partial<Record<GeoCitedContentType, number>>;
}

export interface SurfaceModeComparison {
	surfaceMode: GeoSurfaceMode;
	platforms: GeoPlatform[];
	rows: BrandComparisonRow[];
}

type EvaluatedSample = ReturnType<typeof evaluatedValidSamples>["evaluated"][number];

interface Brand {
	entityId: string | null;
	name: string;
}

function names(brand: Brand, sample: EvaluatedSample): boolean {
	return brand.entityId === null
		? sample.evaluation.brandMentioned
		: sample.evaluation.competitorHits.some((hit) => hit.entityId === brand.entityId && hit.mentioned);
}

/** The brand's own pages or a third party's: another brand's own site says nothing about this one. */
function citedForBrand(brand: Brand, sample: EvaluatedSample, ordinal: number): boolean {
	const owner = sample.evaluation.citations.find((entry) => entry.ordinal === ordinal);
	if (!owner || owner.owner === "THIRD_PARTY") return true;
	return brand.entityId === null ? owner.owner === "OWN" : owner.entityId === brand.entityId;
}

function citedTypes(
	brand: Brand,
	samples: readonly EvaluatedSample[],
	citationsByObservation: Map<string, RecommendationCitation[]>,
	classifications: ReadonlyMap<string, GeoCitedContentType>,
): Partial<Record<GeoCitedContentType, number>> {
	const urlsByType = new Map<GeoCitedContentType, Set<string>>();
	for (const sample of samples.filter((entry) => names(brand, entry))) {
		for (const citation of citationsByObservation.get(sample.observationId) ?? []) {
			const type = classifications.get(citation.url);
			if (!type || !citedForBrand(brand, sample, citation.ordinal)) continue;
			urlsByType.set(type, (urlsByType.get(type) ?? new Set<string>()).add(citation.url));
		}
	}
	return Object.fromEntries([...urlsByType].map(([type, urls]) => [type, urls.size]));
}

/**
 * Us against each competitor on the same answers. Each surface mode stands alone: its
 * rate is a mean over its own platforms, never pooled with another way of capturing answers.
 */
export function compareBrands(input: {
	samples: readonly MetricSample[];
	competitors: readonly CompetitorRef[];
	ownName: string;
	citations: readonly RecommendationCitation[];
	classifications: ReadonlyMap<string, GeoCitedContentType>;
}): SurfaceModeComparison[] {
	const citationsByObservation = new Map<string, RecommendationCitation[]>();
	for (const citation of input.citations) {
		citationsByObservation.set(citation.observationId, [
			...(citationsByObservation.get(citation.observationId) ?? []),
			citation,
		]);
	}
	const byMode = new Map<GeoSurfaceMode, EvaluatedSample[]>();
	for (const sample of evaluatedValidSamples(input.samples).evaluated) {
		byMode.set(sample.surfaceMode, [...(byMode.get(sample.surfaceMode) ?? []), sample]);
	}
	const brands: Brand[] = [
		{ entityId: null, name: input.ownName },
		...input.competitors.map((competitor) => ({ entityId: competitor.entityId, name: competitor.name })),
	];

	const result: SurfaceModeComparison[] = [...byMode].map(([surfaceMode, samples]) => {
		const cells = groupByCell(samples);
		const platforms = [...new Set(samples.map((sample) => sample.platform))].sort();
		const rows = brands.map((brand): BrandComparisonRow => {
			const byPlatform = platforms.map((platform) => {
				const cell = cells.get(`${platform}|${surfaceMode}`) ?? [];
				return { platform, evaluated: cell.length, mentioned: cell.filter((sample) => names(brand, sample)).length };
			});
			const rates = byPlatform.filter((entry) => entry.evaluated > 0).map((entry) => entry.mentioned / entry.evaluated);
			return {
				entityId: brand.entityId,
				name: brand.name,
				byPlatform,
				mentionRate: rates.length > 0 ? rates.reduce((sum, rate) => sum + rate, 0) / rates.length : null,
				citedTypes: citedTypes(brand, samples, citationsByObservation, input.classifications),
			};
		});
		return { surfaceMode, platforms, rows };
	});
	return result.sort((a, b) => a.surfaceMode.localeCompare(b.surfaceMode));
}
