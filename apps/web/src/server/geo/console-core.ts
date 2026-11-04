import {
	assertGeoPermission,
	type GeoBrandKind,
	type GeoCitationOwner,
	type GeoDictionarySnapshot,
	GeoError,
	type GeoPlatform,
	type GeoPrincipal,
	type GeoRecommendation,
	type GeoSurfaceMode,
} from "@workspace/geo-domain";
import {
	type AnswerSegment,
	attributeCitations,
	evaluateWithRules,
	findMentionRanges,
	type MentionRange,
	splitAnswerByMentions,
} from "@workspace/geo-reports/evaluation";
import { db } from "@workspace/lib/db/db";
import {
	geoBuyerRoles,
	geoEvaluations,
	geoObservationCitations,
	geoObservations,
	geoPromptSetItems,
	geoPromptSets,
	geoPrompts,
} from "@workspace/lib/db/schema";
import { buildDictionarySnapshot } from "@workspace/lib/geo/dictionary";
import { and, asc, desc, eq, isNotNull } from "drizzle-orm";

export interface ConsoleQuestion {
	promptId: string;
	questionText: string;
	buyerRoleTitle: string | null;
	priority: string;
	tier: string;
}

export interface ConsoleQuestionSet {
	set: { id: string; name: string; version: number } | null;
	questions: ConsoleQuestion[];
	ownBrandName: string | null;
}

export interface ConsoleSampleSummary {
	id: string;
	platform: GeoPlatform;
	surfaceMode: GeoSurfaceMode;
	sampledAt: string;
	brandMentioned: boolean | null;
	recommendation: GeoRecommendation | null;
	brandRank: number | null;
}

export interface ConsoleCitation {
	ordinal: number;
	url: string;
	title: string | null;
	host: string | null;
	owner: GeoCitationOwner;
	ownerName: string | null;
}

export interface ConsoleOutcome {
	brandMentioned: boolean;
	recommendation: GeoRecommendation;
	brandRank: number | null;
	competitorsMentioned: string[];
}

export interface ConsoleAnswer {
	source: "replay" | "live";
	id: string;
	promptId: string | null;
	questionText: string;
	buyerRoleTitle: string | null;
	platform: GeoPlatform;
	surfaceMode: GeoSurfaceMode;
	sampledAt: string;
	modelVersion: string | null;
	answerText: string;
	segments: AnswerSegment[];
	outcome: ConsoleOutcome;
	citations: ConsoleCitation[];
	ownBrandName: string | null;
}

export async function loadCurrentDictionary(organizationId: string): Promise<GeoDictionarySnapshot> {
	return buildDictionarySnapshot(db, organizationId);
}

export function ownBrandNameOf(dictionary: GeoDictionarySnapshot): string | null {
	return dictionary.entities.find((entity) => entity.kind === "OWN" && entity.status === "ACTIVE")?.displayName ?? null;
}

/** The questions people monitor are those of the most recently frozen set; drafts are not settled wording yet. */
export async function listConsoleQuestions(principal: GeoPrincipal): Promise<ConsoleQuestionSet> {
	assertGeoPermission(principal, "console.read");
	const [[set], dictionary] = await Promise.all([
		db
			.select({ id: geoPromptSets.id, name: geoPromptSets.name, version: geoPromptSets.version })
			.from(geoPromptSets)
			.where(and(eq(geoPromptSets.organizationId, principal.organizationId), eq(geoPromptSets.status, "FROZEN")))
			.orderBy(desc(geoPromptSets.frozenAt))
			.limit(1),
		loadCurrentDictionary(principal.organizationId),
	]);
	const ownBrandName = ownBrandNameOf(dictionary);
	if (!set) return { set: null, questions: [], ownBrandName };
	const items = await db
		.select({
			promptId: geoPromptSetItems.promptId,
			questionText: geoPromptSetItems.questionText,
			labels: geoPromptSetItems.labels,
		})
		.from(geoPromptSetItems)
		.where(eq(geoPromptSetItems.setId, set.id))
		.orderBy(asc(geoPromptSetItems.createdAt));
	return {
		set,
		ownBrandName,
		questions: items
			.map((item) => ({
				promptId: item.promptId,
				questionText: item.questionText,
				buyerRoleTitle: item.labels.buyerRoleTitle ?? null,
				priority: item.labels.priority ?? "P2",
				tier: item.labels.tier ?? "CORE",
			}))
			.sort((a, b) => a.priority.localeCompare(b.priority)),
	};
}

/** Only valid samples can be replayed: a failed or partial capture is not what a buyer would have seen. */
export async function listReplaySamples(principal: GeoPrincipal, promptId: string): Promise<ConsoleSampleSummary[]> {
	assertGeoPermission(principal, "console.read");
	const o = geoObservations;
	const rows = await db
		.select({
			id: o.id,
			platform: o.platform,
			surfaceMode: o.surfaceMode,
			sampledAt: o.sampledAt,
			brandMentioned: geoEvaluations.brandMentioned,
			recommendation: geoEvaluations.recommendation,
			brandRank: geoEvaluations.brandRank,
		})
		.from(o)
		.leftJoin(geoEvaluations, and(eq(geoEvaluations.observationId, o.id), eq(geoEvaluations.isCurrent, true)))
		.where(
			and(
				eq(o.organizationId, principal.organizationId),
				eq(o.promptId, promptId),
				eq(o.status, "VALID"),
				isNotNull(o.responseText),
			),
		)
		.orderBy(desc(o.sampledAt))
		.limit(100);
	return rows.map((row) => ({ ...row, sampledAt: row.sampledAt.toISOString() }));
}

function entityNames(dictionary: GeoDictionarySnapshot): Map<string, { name: string; kind: GeoBrandKind }> {
	return new Map(dictionary.entities.map((entity) => [entity.id, { name: entity.displayName, kind: entity.kind }]));
}

export function consoleCitations(
	citations: readonly { ordinal: number; url: string; title?: string | null }[],
	dictionary: GeoDictionarySnapshot,
): ConsoleCitation[] {
	const names = entityNames(dictionary);
	const attribution = attributeCitations(citations, dictionary);
	return citations.map((citation, index) => {
		const owner = attribution[index];
		return {
			ordinal: citation.ordinal,
			url: citation.url,
			title: citation.title ?? null,
			host: owner?.host ?? null,
			owner: owner?.owner ?? "THIRD_PARTY",
			ownerName: owner?.entityId ? (names.get(owner.entityId)?.name ?? null) : null,
		};
	});
}

/** Reads an answer the way an evaluation would; used where no stored evaluation exists. */
export function ruleOutcome(
	answer: string,
	dictionary: GeoDictionarySnapshot,
	citations: readonly { ordinal: number; url: string }[],
): ConsoleOutcome {
	const evaluation = evaluateWithRules({ answer, dictionary, citations, approvedAssertions: [] });
	return {
		brandMentioned: evaluation.brandMentioned,
		recommendation: evaluation.recommendation,
		brandRank: evaluation.brandRank,
		competitorsMentioned: evaluation.competitorHits.filter((hit) => hit.mentioned).map((hit) => hit.name),
	};
}

export function answerSegments(answer: string, mentions: readonly MentionRange[]): AnswerSegment[] {
	return splitAnswerByMentions(answer, mentions);
}

export async function getReplayAnswer(principal: GeoPrincipal, observationId: string): Promise<ConsoleAnswer> {
	assertGeoPermission(principal, "console.read");
	const o = geoObservations;
	const [row] = await db
		.select({
			observation: {
				id: o.id,
				promptId: o.promptId,
				questionText: o.questionText,
				platform: o.platform,
				surfaceMode: o.surfaceMode,
				status: o.status,
				responseText: o.responseText,
				sampledAt: o.sampledAt,
				modelVersion: o.modelVersion,
			},
			buyerRoleTitle: geoBuyerRoles.title,
		})
		.from(o)
		.innerJoin(geoPrompts, eq(geoPrompts.id, o.promptId))
		.leftJoin(geoBuyerRoles, eq(geoBuyerRoles.id, geoPrompts.buyerRoleId))
		.where(and(eq(o.id, observationId), eq(o.organizationId, principal.organizationId)));
	if (!row) throw new GeoError("NOT_FOUND", "没有找到这条回答记录");
	const { observation } = row;
	if (observation.status !== "VALID" || !observation.responseText) {
		throw new GeoError("NOT_FOUND", "这次采样没有拿到完整回答，无法回放");
	}
	const answer = observation.responseText;

	const [citationRows, [evaluation], dictionary] = await Promise.all([
		db
			.select({
				ordinal: geoObservationCitations.ordinal,
				url: geoObservationCitations.url,
				title: geoObservationCitations.title,
			})
			.from(geoObservationCitations)
			.where(eq(geoObservationCitations.observationId, observation.id))
			.orderBy(asc(geoObservationCitations.ordinal)),
		db
			.select({
				brandMentioned: geoEvaluations.brandMentioned,
				recommendation: geoEvaluations.recommendation,
				brandRank: geoEvaluations.brandRank,
				competitorHits: geoEvaluations.competitorHits,
			})
			.from(geoEvaluations)
			.where(and(eq(geoEvaluations.observationId, observation.id), eq(geoEvaluations.isCurrent, true))),
		loadCurrentDictionary(principal.organizationId),
	]);

	// A reviewed evaluation is the official reading of this answer; the rules only fill in until one exists.
	const outcome: ConsoleOutcome = evaluation
		? {
				brandMentioned: evaluation.brandMentioned,
				recommendation: evaluation.recommendation,
				brandRank: evaluation.brandRank,
				competitorsMentioned: evaluation.competitorHits.filter((hit) => hit.mentioned).map((hit) => hit.name),
			}
		: ruleOutcome(answer, dictionary, citationRows);

	return {
		source: "replay",
		id: observation.id,
		promptId: observation.promptId,
		questionText: observation.questionText,
		buyerRoleTitle: row.buyerRoleTitle,
		platform: observation.platform,
		surfaceMode: observation.surfaceMode,
		sampledAt: observation.sampledAt.toISOString(),
		modelVersion: observation.modelVersion,
		answerText: answer,
		segments: answerSegments(answer, findMentionRanges(answer, dictionary)),
		outcome,
		citations: consoleCitations(citationRows, dictionary),
		ownBrandName: ownBrandNameOf(dictionary),
	};
}
