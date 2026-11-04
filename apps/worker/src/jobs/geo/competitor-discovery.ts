import { GEO_QUEUE } from "@workspace/geo-domain";
import {
	buildCompetitorExtractionPrompt,
	type CompetitorAnswer,
	type CompetitorExtraction,
	type CompetitorTally,
	competitorExtractionSchema,
	tallyCompetitorMentions,
} from "@workspace/geo-reports";
import { db } from "@workspace/lib/db/db";
import {
	geoBrandEntities,
	geoCompetitorCandidates,
	geoObservations,
	geoOrgSettings,
	geoSamplingBatches,
} from "@workspace/lib/db/schema";
import { runStructuredCompletionPrompt } from "@workspace/lib/onboarding";
import { and, desc, eq, gt, isNotNull, sql } from "drizzle-orm";
import { getBoss } from "../../boss";
import { defineGeoQueue, type GeoQueue } from "./queue";

export interface CompetitorDiscoveryJobData {
	organizationId: string;
	/** A sampling batch of discovery questions to wait for before reading answers. */
	batchId?: string;
	waits?: number;
}

const WINDOW_DAYS = 30;
const OBSERVATION_LIMIT = 150;
const ANSWERS_PER_CALL = 8;
const ANSWER_MAX_CHARS = 3000;
const SAMPLES_PER_CANDIDATE = 3;
const WAIT_SECONDS = 120;
const MAX_WAITS = 45;

async function knownBrandTerms(organizationId: string): Promise<string[]> {
	const brands = await db
		.select({
			displayName: geoBrandEntities.displayName,
			legalName: geoBrandEntities.legalName,
			shortName: geoBrandEntities.shortName,
			aliases: geoBrandEntities.aliases,
			historicalNames: geoBrandEntities.historicalNames,
		})
		.from(geoBrandEntities)
		.where(eq(geoBrandEntities.organizationId, organizationId));
	return brands
		.flatMap((brand) => [
			brand.displayName,
			brand.legalName,
			brand.shortName,
			...brand.aliases,
			...brand.historicalNames,
		])
		.filter((term): term is string => Boolean(term));
}

async function batchStillRunning(organizationId: string, batchId: string): Promise<boolean> {
	const [batch] = await db
		.select({ status: geoSamplingBatches.status })
		.from(geoSamplingBatches)
		.where(and(eq(geoSamplingBatches.id, batchId), eq(geoSamplingBatches.organizationId, organizationId)));
	return batch?.status === "PLANNED" || batch?.status === "RUNNING";
}

async function extract(chunk: readonly CompetitorAnswer[]): Promise<CompetitorExtraction | null> {
	const prompt = buildCompetitorExtractionPrompt(
		chunk.map((answer, index) => ({ index, text: answer.text.slice(0, ANSWER_MAX_CHARS) })),
	);
	try {
		return (await runStructuredCompletionPrompt(prompt, competitorExtractionSchema)).object;
	} catch (error) {
		console.warn(
			`[geo-competitors] extraction failed for ${chunk.length} answers: ${error instanceof Error ? error.name : "error"}`,
		);
		return null;
	}
}

type DiscoveryOutcome =
	| { status: "waiting"; waits: number }
	| { status: "skipped"; reason: string }
	| { status: "done"; observations: number; candidates: number };

/**
 * Reads recent valid answers and keeps a running list of the companies they name, so a
 * customer can pick competitors instead of typing them in. Counts are recomputed over the
 * window each time; a candidate someone already accepted or dismissed keeps its decision.
 */
export async function discoverCompetitors(data: CompetitorDiscoveryJobData): Promise<DiscoveryOutcome> {
	const { organizationId, batchId } = data;
	const waits = data.waits ?? 0;
	if (batchId && waits < MAX_WAITS && (await batchStillRunning(organizationId, batchId))) {
		await getBoss().send(
			GEO_QUEUE.competitorDiscovery,
			{ organizationId, batchId, waits: waits + 1 },
			{ startAfter: WAIT_SECONDS },
		);
		return { status: "waiting", waits: waits + 1 };
	}

	const [settings] = await db
		.select({ approved: geoOrgSettings.llmUseApproved })
		.from(geoOrgSettings)
		.where(eq(geoOrgSettings.organizationId, organizationId));
	if (settings?.approved !== true) return { status: "skipped", reason: "llm-not-approved" };

	const observations = await db
		.select({
			id: geoObservations.id,
			platform: geoObservations.platform,
			responseText: geoObservations.responseText,
			sampledAt: geoObservations.sampledAt,
		})
		.from(geoObservations)
		.where(
			and(
				eq(geoObservations.organizationId, organizationId),
				eq(geoObservations.status, "VALID"),
				isNotNull(geoObservations.responseText),
				gt(geoObservations.sampledAt, new Date(Date.now() - WINDOW_DAYS * 86_400_000)),
			),
		)
		.orderBy(desc(geoObservations.sampledAt))
		.limit(OBSERVATION_LIMIT);
	if (observations.length === 0) return { status: "done", observations: 0, candidates: 0 };

	const known = await knownBrandTerms(organizationId);
	const answers: CompetitorAnswer[] = observations.map((row) => ({
		id: row.id,
		platform: row.platform,
		text: row.responseText ?? "",
		sampledAt: row.sampledAt,
	}));
	const tallies = new Map<string, CompetitorTally>();
	for (let start = 0; start < answers.length; start += ANSWERS_PER_CALL) {
		const chunk = answers.slice(start, start + ANSWERS_PER_CALL);
		const extraction = await extract(chunk);
		if (extraction) tallyCompetitorMentions(tallies, chunk, extraction, known);
	}

	const now = new Date();
	for (const tally of tallies.values()) {
		const values = {
			name: tally.name,
			aliases: tally.aliases,
			domains: tally.domains,
			mentionCount: tally.mentionCount,
			observationCount: tally.observationIds.length,
			platforms: tally.platforms,
			sampleObservationIds: tally.observationIds.slice(0, SAMPLES_PER_CANDIDATE),
			lastSeenAt: tally.lastSeenAt,
		};
		await db
			.insert(geoCompetitorCandidates)
			.values({ organizationId, normalizedName: tally.normalizedName, ...values })
			.onConflictDoUpdate({
				target: [geoCompetitorCandidates.organizationId, geoCompetitorCandidates.normalizedName],
				set: { ...values, updatedAt: now },
				setWhere: sql`${geoCompetitorCandidates.status} <> 'ACCEPTED'`,
			});
	}
	console.log(
		`[geo-competitors] read ${observations.length} answers for ${organizationId}, ${tallies.size} companies named`,
	);
	return { status: "done", observations: observations.length, candidates: tallies.size };
}

export const GEO_COMPETITOR_QUEUES: GeoQueue[] = [
	defineGeoQueue<CompetitorDiscoveryJobData>({
		name: GEO_QUEUE.competitorDiscovery,
		options: { retryLimit: 1, retryDelay: 60, expireInSeconds: 30 * 60 },
		work: { batchSize: 1, localConcurrency: 1 },
		handler: async ([job]) => discoverCompetitors(job.data),
	}),
];
