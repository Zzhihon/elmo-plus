import {
	assertGeoPermission,
	GEO_PLATFORMS,
	GEO_RECOMMENDATIONS,
	GEO_REVIEW_REASONS,
	GEO_SURFACE_MODES,
	type GeoClaimKind,
	type GeoClaimMatchStatus,
	type GeoClaimVerdict,
	GeoError,
	type GeoEvaluationReviewStatus,
	type GeoPrincipal,
	type GeoRecommendation,
	type GeoReviewReason,
} from "@workspace/geo-domain";
import { db } from "@workspace/lib/db/db";
import {
	geoDictionaryVersions,
	geoEvaluations,
	geoObservationClaims,
	geoObservations,
	geoPrompts,
} from "@workspace/lib/db/schema";
import { writeGeoAudit } from "@workspace/lib/geo/audit";
import { and, asc, count, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";

type Paging = { page: number; limit: number; offset: number };
type EvaluationRow = typeof geoEvaluations.$inferSelect;

export interface ReviewEvaluation {
	id: string;
	version: number;
	evaluatorVersion: string;
	dictionaryVersion: number | null;
	brandMentioned: boolean;
	recommendation: GeoRecommendation;
	hasOrderedList: boolean;
	brandRank: number | null;
	confidence: number | null;
	reviewStatus: GeoEvaluationReviewStatus;
	reviewReasons: GeoReviewReason[];
	isCurrent: boolean;
	supersedesId: string | null;
	createdBy: string;
	reason: string | null;
	createdAt: string;
	competitorHits: EvaluationRow["competitorHits"];
	evidenceSpans: EvaluationRow["evidenceSpans"];
	citationAttribution: EvaluationRow["citationAttribution"];
	signals: EvaluationRow["signals"];
}

export interface ReviewClaim {
	id: string;
	claimText: string;
	span: { start: number; end: number } | null;
	claimKind: GeoClaimKind;
	extractedValue: string | null;
	referenceValue: string | null;
	matchStatus: GeoClaimMatchStatus;
	assertionId: string | null;
	verdict: GeoClaimVerdict;
	reviewerId: string | null;
	reviewedAt: string | null;
	reviewNote: string | null;
}

export interface ObservationReview {
	observationId: string;
	evaluations: ReviewEvaluation[];
	claims: ReviewClaim[];
}

async function loadObservation(organizationId: string, observationId: string) {
	const [observation] = await db
		.select({ id: geoObservations.id, status: geoObservations.status, promptId: geoObservations.promptId })
		.from(geoObservations)
		.where(and(eq(geoObservations.id, observationId), eq(geoObservations.organizationId, organizationId)));
	if (!observation) throw new GeoError("NOT_FOUND", "证据不存在");
	return observation;
}

/** Every evaluation version with the evidence it rests on, and every fact claim pulled from the answer. */
export async function getObservationReview(principal: GeoPrincipal, observationId: string): Promise<ObservationReview> {
	assertGeoPermission(principal, "observation.read");
	await loadObservation(principal.organizationId, observationId);
	const [evaluations, claims] = await Promise.all([
		db
			.select({ evaluation: geoEvaluations, dictionaryVersion: geoDictionaryVersions.version })
			.from(geoEvaluations)
			.leftJoin(geoDictionaryVersions, eq(geoDictionaryVersions.id, geoEvaluations.dictionaryVersionId))
			.where(eq(geoEvaluations.observationId, observationId))
			.orderBy(desc(geoEvaluations.version)),
		db
			.select()
			.from(geoObservationClaims)
			.where(eq(geoObservationClaims.observationId, observationId))
			.orderBy(asc(geoObservationClaims.createdAt)),
	]);
	return {
		observationId,
		evaluations: evaluations.map(({ evaluation, dictionaryVersion }) => ({
			id: evaluation.id,
			version: evaluation.version,
			evaluatorVersion: evaluation.evaluatorVersion,
			dictionaryVersion,
			brandMentioned: evaluation.brandMentioned,
			recommendation: evaluation.recommendation,
			hasOrderedList: evaluation.hasOrderedList,
			brandRank: evaluation.brandRank,
			confidence: evaluation.confidence,
			reviewStatus: evaluation.reviewStatus,
			reviewReasons: evaluation.reviewReasons,
			isCurrent: evaluation.isCurrent,
			supersedesId: evaluation.supersedesId,
			createdBy: evaluation.createdBy,
			reason: evaluation.reason,
			createdAt: evaluation.createdAt.toISOString(),
			competitorHits: evaluation.competitorHits,
			evidenceSpans: evaluation.evidenceSpans,
			citationAttribution: evaluation.citationAttribution,
			signals: evaluation.signals,
		})),
		claims: claims.map((claim) => ({
			id: claim.id,
			claimText: claim.claimText,
			span: claim.span ?? null,
			claimKind: claim.claimKind,
			extractedValue: claim.extractedValue,
			referenceValue: claim.referenceValue,
			matchStatus: claim.matchStatus,
			assertionId: claim.assertionId,
			verdict: claim.verdict,
			reviewerId: claim.reviewerId,
			reviewedAt: claim.reviewedAt?.toISOString() ?? null,
			reviewNote: claim.reviewNote,
		})),
	};
}

const reasonText = z.string().trim().min(2, "请填写复核依据").max(1000);

export const evaluationReviewSchema = z.object({
	type: z.literal("evaluation"),
	decision: z.enum(["CONFIRM", "CORRECT"]),
	/** The version the reviewer looked at: a review of anything older is refused, not applied. */
	expectedEvaluationId: z.guid(),
	brandMentioned: z.boolean().optional(),
	recommendation: z.enum(GEO_RECOMMENDATIONS).optional(),
	hasOrderedList: z.boolean().optional(),
	brandRank: z.number().int().min(1).max(50).nullable().optional(),
	reason: z.string().trim().max(1000).optional(),
});

export const claimReviewSchema = z.object({
	type: z.literal("claim"),
	claimId: z.guid(),
	verdict: z.enum(["CORRECT", "ERROR", "UNVERIFIED"]),
	note: z.string().trim().max(1000).optional(),
});

export const observationReviewInputSchema = z.discriminatedUnion("type", [evaluationReviewSchema, claimReviewSchema]);
export type ObservationReviewInput = z.infer<typeof observationReviewInputSchema>;

interface Judgement {
	brandMentioned: boolean;
	recommendation: GeoRecommendation;
	hasOrderedList: boolean;
	brandRank: number | null;
}

function correctedJudgement(current: EvaluationRow, input: z.infer<typeof evaluationReviewSchema>): Judgement {
	const next: Judgement = {
		brandMentioned: input.brandMentioned ?? current.brandMentioned,
		recommendation: input.recommendation ?? current.recommendation,
		hasOrderedList: input.hasOrderedList ?? current.hasOrderedList,
		brandRank: input.brandRank === undefined ? current.brandRank : input.brandRank,
	};
	if (!next.brandMentioned && next.recommendation !== "NOT_MENTIONED") {
		throw new GeoError("VALIDATION_ERROR", "未提及品牌时结论只能是“未提及”");
	}
	if (next.brandMentioned && next.recommendation === "NOT_MENTIONED") {
		throw new GeoError("VALIDATION_ERROR", "提及了品牌时结论不能是“未提及”");
	}
	if (next.brandRank !== null && (!next.hasOrderedList || !next.brandMentioned)) {
		throw new GeoError("VALIDATION_ERROR", "只有在可判定的排序清单中提及品牌时才能填写排名");
	}
	const unchanged =
		next.brandMentioned === current.brandMentioned &&
		next.recommendation === current.recommendation &&
		next.hasOrderedList === current.hasOrderedList &&
		next.brandRank === current.brandRank;
	if (unchanged) throw new GeoError("VALIDATION_ERROR", "更正内容与当前结论相同，如结论正确请选择“确认”");
	return next;
}

function judgementOf(row: Judgement & { reviewStatus: string; version: number }) {
	return {
		version: row.version,
		brandMentioned: row.brandMentioned,
		recommendation: row.recommendation,
		hasOrderedList: row.hasOrderedList,
		brandRank: row.brandRank,
		reviewStatus: row.reviewStatus,
	};
}

/**
 * A review never edits an evaluation: confirming or correcting it appends a new version,
 * makes that the current one, and records both in the audit log, so the original
 * automated result and the answer itself stay exactly as they were (UAT-07).
 */
async function reviewEvaluation(
	principal: GeoPrincipal,
	observationId: string,
	input: z.infer<typeof evaluationReviewSchema>,
): Promise<ReviewEvaluation["id"]> {
	assertGeoPermission(principal, "observation.review");
	if (input.decision === "CORRECT") reasonText.parse(input.reason ?? "");
	return db.transaction(async (tx) => {
		await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`geo-evaluation:${observationId}`}, 0))`);
		const [current] = await tx
			.select()
			.from(geoEvaluations)
			.where(
				and(
					eq(geoEvaluations.observationId, observationId),
					eq(geoEvaluations.organizationId, principal.organizationId),
					eq(geoEvaluations.isCurrent, true),
				),
			)
			.for("update");
		if (!current) throw new GeoError("CONFLICT", "该证据尚未评估，暂不能复核");
		if (current.id !== input.expectedEvaluationId) {
			throw new GeoError("CONFLICT", "评估已更新为新版本，请刷新后再复核");
		}
		if (current.createdBy === principal.actorId) {
			throw new GeoError("FORBIDDEN", "不能复核自己给出的结论，请由另一位审核人确认");
		}
		const judgement =
			input.decision === "CORRECT"
				? correctedJudgement(current, input)
				: {
						brandMentioned: current.brandMentioned,
						recommendation: current.recommendation,
						hasOrderedList: current.hasOrderedList,
						brandRank: current.brandRank,
					};
		const [{ next } = { next: 1 }] = await tx
			.select({ next: sql<number>`coalesce(max(${geoEvaluations.version}), 0)::int + 1` })
			.from(geoEvaluations)
			.where(eq(geoEvaluations.observationId, observationId));
		await tx.update(geoEvaluations).set({ isCurrent: false }).where(eq(geoEvaluations.id, current.id));
		const reviewStatus: GeoEvaluationReviewStatus = input.decision === "CORRECT" ? "CORRECTED" : "CONFIRMED";
		const [created] = await tx
			.insert(geoEvaluations)
			.values({
				organizationId: principal.organizationId,
				observationId,
				version: next,
				evaluatorVersion: current.evaluatorVersion,
				dictionaryVersionId: current.dictionaryVersionId,
				...judgement,
				competitorHits: current.competitorHits,
				evidenceSpans: current.evidenceSpans,
				citationAttribution: current.citationAttribution,
				signals: current.signals,
				confidence: 1,
				reviewStatus,
				reviewReasons: [],
				reviewPriority: 0,
				isCurrent: true,
				supersedesId: current.id,
				createdBy: principal.actorId,
				reason: input.reason || null,
			})
			.returning({ id: geoEvaluations.id });
		if (!created) throw new Error("evaluation insert returned nothing");
		await writeGeoAudit(tx, {
			principal,
			action: input.decision === "CORRECT" ? "evaluation.correct" : "evaluation.confirm",
			entityType: "observation",
			entityId: observationId,
			before: judgementOf(current),
			after: judgementOf({ ...judgement, reviewStatus, version: next }),
			metadata: { evaluationId: created.id, supersedes: current.id, version: next },
		});
		return created.id;
	});
}

/**
 * Only a technical reviewer settles whether a claim in an answer is right; a confirmed
 * error is what the error-description rate counts, so it must come with a basis.
 */
async function reviewClaim(principal: GeoPrincipal, observationId: string, input: z.infer<typeof claimReviewSchema>) {
	assertGeoPermission(principal, "claim.review");
	if (input.verdict === "ERROR") reasonText.parse(input.note ?? "");
	return db.transaction(async (tx) => {
		const [claim] = await tx
			.select()
			.from(geoObservationClaims)
			.where(
				and(
					eq(geoObservationClaims.id, input.claimId),
					eq(geoObservationClaims.observationId, observationId),
					eq(geoObservationClaims.organizationId, principal.organizationId),
				),
			)
			.for("update");
		if (!claim) throw new GeoError("NOT_FOUND", "断言不存在");
		await tx
			.update(geoObservationClaims)
			.set({
				verdict: input.verdict,
				reviewerId: input.verdict === "UNVERIFIED" ? null : principal.actorId,
				reviewedAt: input.verdict === "UNVERIFIED" ? null : new Date(),
				reviewNote: input.note || null,
			})
			.where(eq(geoObservationClaims.id, claim.id));
		await writeGeoAudit(tx, {
			principal,
			action: "claim.review",
			entityType: "observation_claim",
			entityId: claim.id,
			before: { verdict: claim.verdict, reviewerId: claim.reviewerId },
			after: { verdict: input.verdict, reviewerId: principal.actorId },
			metadata: { observationId, verdict: input.verdict },
		});
		return claim.id;
	});
}

export async function submitObservationReview(
	principal: GeoPrincipal,
	observationId: string,
	input: ObservationReviewInput,
): Promise<ObservationReview> {
	await loadObservation(principal.organizationId, observationId);
	if (input.type === "evaluation") await reviewEvaluation(principal, observationId, input);
	else await reviewClaim(principal, observationId, input);
	return getObservationReview(principal, observationId);
}

export const reviewPoolQuerySchema = z.object({
	reason: z.enum(GEO_REVIEW_REASONS).optional(),
	platform: z.enum(GEO_PLATFORMS).optional(),
	surfaceMode: z.enum(GEO_SURFACE_MODES).optional(),
});
export type ReviewPoolQuery = z.infer<typeof reviewPoolQuerySchema>;

export interface ReviewPoolItem {
	observationId: string;
	evaluationId: string;
	version: number;
	questionText: string;
	promptPriority: string;
	platform: (typeof GEO_PLATFORMS)[number];
	surfaceMode: (typeof GEO_SURFACE_MODES)[number];
	sampledAt: string;
	recommendation: GeoRecommendation;
	brandMentioned: boolean;
	confidence: number | null;
	reviewReasons: GeoReviewReason[];
	reviewPriority: number;
	pendingClaims: number;
	createdAt: string;
}

/** Evaluations waiting for a person, most important first: high-value questions and fact mismatches lead. */
export async function listReviewPool(
	principal: GeoPrincipal,
	query: ReviewPoolQuery,
	paging: Paging,
): Promise<{ rows: ReviewPoolItem[]; total: number }> {
	assertGeoPermission(principal, "observation.read");
	const e = geoEvaluations;
	const o = geoObservations;
	const where = and(
		eq(e.organizationId, principal.organizationId),
		eq(e.isCurrent, true),
		eq(e.reviewStatus, "PENDING_REVIEW"),
		query.reason ? sql`${query.reason} = any(${e.reviewReasons})` : undefined,
		query.platform ? eq(o.platform, query.platform) : undefined,
		query.surfaceMode ? eq(o.surfaceMode, query.surfaceMode) : undefined,
	);
	const [rows, [total]] = await Promise.all([
		db
			.select({
				observationId: o.id,
				evaluationId: e.id,
				version: e.version,
				questionText: o.questionText,
				promptPriority: geoPrompts.priority,
				platform: o.platform,
				surfaceMode: o.surfaceMode,
				sampledAt: o.sampledAt,
				recommendation: e.recommendation,
				brandMentioned: e.brandMentioned,
				confidence: e.confidence,
				reviewReasons: e.reviewReasons,
				reviewPriority: e.reviewPriority,
				createdAt: e.createdAt,
				pendingClaims: sql<number>`(select count(*)::int from ${geoObservationClaims} c where c.observation_id = ${o.id} and c.verdict = 'UNVERIFIED' and c.match_status = 'MISMATCH')`,
			})
			.from(e)
			.innerJoin(o, eq(o.id, e.observationId))
			.innerJoin(geoPrompts, eq(geoPrompts.id, o.promptId))
			.where(where)
			.orderBy(desc(e.reviewPriority), asc(e.createdAt))
			.limit(paging.limit)
			.offset(paging.offset),
		db.select({ value: count() }).from(e).innerJoin(o, eq(o.id, e.observationId)).where(where),
	]);
	return {
		rows: rows.map((row) => ({
			...row,
			sampledAt: row.sampledAt.toISOString(),
			createdAt: row.createdAt.toISOString(),
		})),
		total: total?.value ?? 0,
	};
}
