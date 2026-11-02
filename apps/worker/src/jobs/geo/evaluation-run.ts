import {
	GEO_EVALUATE_OBSERVATION_QUEUE,
	type GeoDictionarySnapshot,
	type GeoLlmSignals,
	type GeoObservationStatus,
	type GeoPriority,
	isEvaluableObservation,
} from "@workspace/geo-domain";
import {
	type ApprovedAssertion,
	buildSemanticPrompt,
	evaluateWithRules,
	finalizeEvaluation,
	type LlmOutcome,
	locateQuote,
	semanticJudgementSchema,
} from "@workspace/geo-reports/evaluation";
import { db } from "@workspace/lib/db/db";
import {
	geoDictionaryVersions,
	geoEvaluations,
	geoKnowledgeAssertions,
	geoObservationCitations,
	geoObservationClaims,
	geoObservations,
	geoOrgSettings,
	geoPromptSetItems,
	geoPrompts,
} from "@workspace/lib/db/schema";
import { runStructuredCompletionPrompt } from "@workspace/lib/onboarding";
import { and, asc, desc, eq, gt, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { getBoss } from "../../boss";

export interface EvaluationJobData {
	organizationId?: string;
	observationId?: string;
}

type Observation = typeof geoObservations.$inferSelect;

const ASSERTION_LIMIT = 5000;

/**
 * The dictionary as it stood when the answer was sampled, so a later alias change never
 * rewrites how an old answer reads. An answer sampled before the first version uses the first.
 */
async function dictionaryAt(organizationId: string, sampledAt: Date) {
	const [atTime] = await db
		.select({ id: geoDictionaryVersions.id, snapshot: geoDictionaryVersions.snapshot })
		.from(geoDictionaryVersions)
		.where(
			and(eq(geoDictionaryVersions.organizationId, organizationId), lte(geoDictionaryVersions.createdAt, sampledAt)),
		)
		.orderBy(desc(geoDictionaryVersions.version))
		.limit(1);
	if (atTime) return atTime;
	const [first] = await db
		.select({ id: geoDictionaryVersions.id, snapshot: geoDictionaryVersions.snapshot })
		.from(geoDictionaryVersions)
		.where(eq(geoDictionaryVersions.organizationId, organizationId))
		.orderBy(asc(geoDictionaryVersions.version))
		.limit(1);
	return first ?? null;
}

/** Approved, unexpired facts only, read straight from the knowledge table. */
async function approvedAssertions(organizationId: string): Promise<ApprovedAssertion[]> {
	return db
		.select({
			id: geoKnowledgeAssertions.id,
			claimText: geoKnowledgeAssertions.claimText,
			normalizedValue: geoKnowledgeAssertions.normalizedValue,
		})
		.from(geoKnowledgeAssertions)
		.where(
			and(
				eq(geoKnowledgeAssertions.organizationId, organizationId),
				eq(geoKnowledgeAssertions.status, "APPROVED"),
				or(isNull(geoKnowledgeAssertions.validUntil), gt(geoKnowledgeAssertions.validUntil, new Date())),
			),
		)
		.limit(ASSERTION_LIMIT);
}

/** The question's priority as frozen in its set, falling back to the question itself. */
async function promptPriority(observation: Observation): Promise<GeoPriority | null> {
	const [row] = await db
		.select({
			priority: sql<GeoPriority | null>`coalesce(${geoPromptSetItems.labels}->>'priority', ${geoPrompts.priority})`,
		})
		.from(geoPrompts)
		.leftJoin(
			geoPromptSetItems,
			and(
				eq(geoPromptSetItems.promptId, geoPrompts.id),
				observation.promptSetId ? eq(geoPromptSetItems.setId, observation.promptSetId) : sql`false`,
			),
		)
		.where(eq(geoPrompts.id, observation.promptId));
	return row?.priority ?? null;
}

async function llmApproved(organizationId: string): Promise<boolean> {
	const [settings] = await db
		.select({ approved: geoOrgSettings.llmUseApproved })
		.from(geoOrgSettings)
		.where(eq(geoOrgSettings.organizationId, organizationId));
	return settings?.approved === true;
}

/** Only asked when the organization approved model use; a failure leaves the rules' result to stand. */
async function askModel(
	observation: Observation,
	answer: string,
	dictionary: GeoDictionarySnapshot,
): Promise<LlmOutcome> {
	try {
		const result = await runStructuredCompletionPrompt(
			buildSemanticPrompt({ question: observation.questionText, answer, dictionary }),
			semanticJudgementSchema,
		);
		const judgement = result.object;
		const signals: GeoLlmSignals = {
			model: result.modelVersion ?? null,
			brandMentioned: judgement.brandMentioned,
			recommendation: judgement.recommendation,
			hasOrderedList: judgement.hasOrderedList,
			brandRank: judgement.brandRank,
			confidence: judgement.confidence,
			evidenceQuote: judgement.evidenceQuote,
			quoteFound: locateQuote(answer, judgement.evidenceQuote),
		};
		return signals;
	} catch (error) {
		return { error: error instanceof Error ? error.name : "error" };
	}
}

export type EvaluationOutcome =
	| { evaluated: true; evaluationId: string; reviewStatus: string }
	| { evaluated: false; reason: string };

/**
 * Evaluates one stored answer once. A second run finds the existing evaluation and stops,
 * so a duplicate job or the sweep can never stack automatic versions or overwrite a
 * reviewer's correction.
 */
export async function evaluateObservation(organizationId: string, observationId: string): Promise<EvaluationOutcome> {
	const [observation] = await db
		.select()
		.from(geoObservations)
		.where(and(eq(geoObservations.id, observationId), eq(geoObservations.organizationId, organizationId)));
	if (!observation) return { evaluated: false, reason: "not-found" };
	if (!isEvaluableObservation(observation.status as GeoObservationStatus) || !observation.responseText) {
		return { evaluated: false, reason: "not-evaluable" };
	}
	const [existing] = await db
		.select({ id: geoEvaluations.id })
		.from(geoEvaluations)
		.where(eq(geoEvaluations.observationId, observationId))
		.limit(1);
	if (existing) return { evaluated: false, reason: "already-evaluated" };

	const dictionary = await dictionaryAt(organizationId, observation.sampledAt);
	if (!dictionary) return { evaluated: false, reason: "no-dictionary" };

	const answer = observation.responseText;
	const [citations, assertions, priority, useModel] = await Promise.all([
		db
			.select({
				ordinal: geoObservationCitations.ordinal,
				url: geoObservationCitations.url,
				normalizedUrl: geoObservationCitations.normalizedUrl,
				host: geoObservationCitations.host,
			})
			.from(geoObservationCitations)
			.where(eq(geoObservationCitations.observationId, observationId))
			.orderBy(asc(geoObservationCitations.ordinal)),
		approvedAssertions(organizationId),
		promptPriority(observation),
		llmApproved(organizationId),
	]);
	const rules = evaluateWithRules({
		answer,
		dictionary: dictionary.snapshot,
		citations,
		approvedAssertions: assertions,
	});
	const llm = useModel ? await askModel(observation, answer, dictionary.snapshot) : null;
	const final = finalizeEvaluation(rules, llm, priority);

	return db.transaction(async (tx) => {
		await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`geo-evaluation:${observationId}`}, 0))`);
		const [raced] = await tx
			.select({ id: geoEvaluations.id })
			.from(geoEvaluations)
			.where(eq(geoEvaluations.observationId, observationId))
			.limit(1);
		if (raced) return { evaluated: false as const, reason: "already-evaluated" };
		const [evaluation] = await tx
			.insert(geoEvaluations)
			.values({
				organizationId,
				observationId,
				version: 1,
				evaluatorVersion: final.evaluatorVersion,
				dictionaryVersionId: dictionary.id,
				brandMentioned: final.brandMentioned,
				recommendation: final.recommendation,
				hasOrderedList: final.hasOrderedList,
				brandRank: final.brandRank,
				competitorHits: rules.competitorHits,
				evidenceSpans: rules.evidenceSpans,
				citationAttribution: rules.citationAttribution,
				signals: final.signals,
				confidence: final.confidence,
				reviewStatus: final.reviewStatus,
				reviewReasons: final.reviewReasons,
				reviewPriority: final.reviewPriority,
				isCurrent: true,
				createdBy: "system:evaluation",
			})
			.returning({ id: geoEvaluations.id });
		if (!evaluation) throw new Error("evaluation insert returned nothing");
		if (rules.claims.length > 0) {
			await tx.insert(geoObservationClaims).values(
				rules.claims.map((claim) => ({
					organizationId,
					observationId,
					evaluationId: evaluation.id,
					claimText: claim.text,
					span: claim.span,
					claimKind: claim.kind,
					extractedValue: claim.value,
					referenceValue: claim.referenceValue,
					matchStatus: claim.matchStatus,
					assertionId: claim.assertionId,
					verdict: claim.verdict,
				})),
			);
		}
		return { evaluated: true as const, evaluationId: evaluation.id, reviewStatus: final.reviewStatus };
	});
}

/** An answer this old with no evaluation lost its job (or arrived before the queue existed). */
const UNEVALUATED_AFTER_MS = 2 * 60_000;
const SWEEP_LIMIT = 500;

export async function sweepUnevaluated(): Promise<{ queued: number }> {
	const cutoff = new Date(Date.now() - UNEVALUATED_AFTER_MS);
	const rows = await db
		.select({ organizationId: geoObservations.organizationId, id: geoObservations.id })
		.from(geoObservations)
		.leftJoin(geoEvaluations, eq(geoEvaluations.observationId, geoObservations.id))
		.where(
			and(
				inArray(geoObservations.status, ["VALID", "PARTIAL"]),
				sql`${geoObservations.responseText} is not null`,
				isNull(geoEvaluations.id),
				lt(geoObservations.createdAt, cutoff),
			),
		)
		.orderBy(asc(geoObservations.createdAt))
		.limit(SWEEP_LIMIT);
	if (rows.length === 0) return { queued: 0 };
	await getBoss().insert(
		GEO_EVALUATE_OBSERVATION_QUEUE,
		rows.map((row) => ({
			data: { organizationId: row.organizationId, observationId: row.id },
			singletonKey: `observation:${row.id}`,
			singletonSeconds: 15 * 60,
		})),
	);
	return { queued: rows.length };
}
