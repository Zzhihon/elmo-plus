import type { GeoCitedContentType } from "@workspace/geo-domain";
import type { DbConnection } from "@workspace/lib/db/db-connection";
import { geoCitationClassifications, geoObservationCitations } from "@workspace/lib/db/schema";
import { inArray } from "drizzle-orm";
import { type CompetitorRef, evaluatedValidSamples, type MetricSample } from "../metrics";
import { GEO_RECOMMENDATION_WINDOW_DAYS, type RecommendationCitation } from "../recommendations/generate";
import { defaultPromptSet, loadMetricData, type PromptSetRef } from "./samples";

export interface RecommendationEvidenceData {
	promptSet: PromptSetRef | null;
	from: Date;
	to: Date;
	samples: MetricSample[];
	competitors: CompetitorRef[];
	citations: RecommendationCitation[];
}

const CHUNK = 5000;

/**
 * The answers recommendations read: the question set most sampled in the window (one
 * fixed set, never a mix), and the cited pages of its evaluated valid answers.
 */
export async function loadRecommendationEvidence(
	db: DbConnection,
	organizationId: string,
	now: Date = new Date(),
): Promise<RecommendationEvidenceData> {
	const to = now;
	const from = new Date(now.getTime() - GEO_RECOMMENDATION_WINDOW_DAYS * 86_400_000);
	const promptSet = await defaultPromptSet(db, organizationId, { from, to });
	if (!promptSet) return { promptSet: null, from, to, samples: [], competitors: [], citations: [] };
	const data = await loadMetricData(db, organizationId, { from, to, promptSetId: promptSet.id });
	const ids = evaluatedValidSamples(data.samples).evaluated.map((sample) => sample.observationId);
	const citations: RecommendationCitation[] = [];
	for (let index = 0; index < ids.length; index += CHUNK) {
		const rows = await db
			.select({
				observationId: geoObservationCitations.observationId,
				ordinal: geoObservationCitations.ordinal,
				url: geoObservationCitations.url,
				normalizedUrl: geoObservationCitations.normalizedUrl,
				title: geoObservationCitations.title,
			})
			.from(geoObservationCitations)
			.where(inArray(geoObservationCitations.observationId, ids.slice(index, index + CHUNK)));
		for (const row of rows) {
			citations.push({
				observationId: row.observationId,
				ordinal: row.ordinal,
				url: row.normalizedUrl ?? row.url,
				title: row.title,
			});
		}
	}
	return { promptSet, from, to, samples: data.samples, competitors: data.competitors, citations };
}

export async function loadCitationClassifications(
	db: DbConnection,
	urls: readonly string[],
): Promise<Map<string, GeoCitedContentType>> {
	const result = new Map<string, GeoCitedContentType>();
	const unique = [...new Set(urls)];
	for (let index = 0; index < unique.length; index += CHUNK) {
		const rows = await db
			.select({ url: geoCitationClassifications.url, contentType: geoCitationClassifications.contentType })
			.from(geoCitationClassifications)
			.where(inArray(geoCitationClassifications.url, unique.slice(index, index + CHUNK)));
		for (const row of rows) result.set(row.url, row.contentType);
	}
	return result;
}
