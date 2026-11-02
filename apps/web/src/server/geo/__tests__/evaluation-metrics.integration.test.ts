import { randomUUID } from "node:crypto";
import {
	type GeoPrincipal,
	type GeoRecommendation,
	type GeoRunStatus,
	samplingRunIdempotencyKey,
} from "@workspace/geo-domain";
import { db } from "@workspace/lib/db/db";
import {
	geoEvaluations,
	geoObservationClaims,
	geoObservations,
	geoSamplingBatches,
	geoSamplingRuns,
} from "@workspace/lib/db/schema";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { getObservationReview, listReviewPool, submitObservationReview } from "@/server/geo/evaluation-core";
import { getInsights, getOverview, listClaimIssues } from "@/server/geo/metrics-core";
import { getObservation, listObservations } from "@/server/geo/observations-core";
import { createBrand } from "@/server/geo/profile-core";
import {
	createPrompt,
	createPromptSet,
	freezePromptSet,
	listBuyerRoles,
	transitionPrompt,
} from "@/server/geo/prompts-core";
import { createSamplingTarget } from "@/server/geo/sampling-targets-core";
import { createGeoOrganization, expectGeoError } from "@/test/integration/geo-fixtures";

let operator: GeoPrincipal;
let marketing: GeoPrincipal;
let tech: GeoPrincipal;
let organizationId: string;
let promptSetId: string;
let competitorId: string;
const ids: Record<string, string> = {};

interface Judged {
	mentioned: boolean;
	recommendation: GeoRecommendation;
	ordered?: boolean;
	rank?: number | null;
	pending?: boolean;
	competitor?: boolean;
	ownCitation?: boolean;
}

/** A first, automated evaluation of one answer, as the evaluation job stores it. */
async function insertEvaluation(observationId: string, judged: Judged): Promise<string> {
	const competitorHits = [
		{
			entityId: competitorId,
			name: "样板开关",
			mentioned: judged.competitor === true,
			recommendation: judged.competitor ? ("MENTIONED_ONLY" as const) : ("NOT_MENTIONED" as const),
			rank: judged.competitor ? 2 : null,
		},
	];
	const citationAttribution = judged.ownCitation
		? [
				{
					ordinal: 0,
					normalizedUrl: "https://www.example-electric.test/p",
					host: "www.example-electric.test",
					owner: "OWN" as const,
					entityId: null,
				},
			]
		: [];
	const [evaluation] = await db
		.insert(geoEvaluations)
		.values({
			organizationId,
			observationId,
			version: 1,
			evaluatorVersion: "rules-test",
			brandMentioned: judged.mentioned,
			recommendation: judged.recommendation,
			hasOrderedList: judged.ordered ?? false,
			brandRank: judged.rank ?? null,
			competitorHits,
			citationAttribution,
			reviewStatus: judged.pending ? "PENDING_REVIEW" : "AUTO_ACCEPTED",
			reviewReasons: judged.pending ? ["LOW_CONFIDENCE"] : [],
			createdBy: "system:evaluation",
		})
		.returning();
	return evaluation.id;
}

beforeAll(async () => {
	const org = await createGeoOrganization();
	organizationId = org.organizationId;
	operator = await org.actor(["geo_operator"]);
	marketing = await org.actor(["marketing_reviewer"]);
	tech = await org.actor(["tech_reviewer"]);
	const admin = await org.actor(["platform_admin"]);
	await createBrand(admin, { kind: "OWN", displayName: "示例电气", domains: ["www.example-electric.test"] });
	competitorId = (await createBrand(admin, { kind: "COMPETITOR", displayName: "样板开关" })).id;

	const [role] = await listBuyerRoles(operator);
	const labels = { buyerRoleId: role?.id, intent: "选型", productLine: "开关柜", geoRegion: "华东" };
	const promptIds: string[] = [];
	for (const question of ["高低压开关柜哪家好？", "环网柜厂家推荐"]) {
		const prompt = await createPrompt(operator, { question, ...labels });
		await transitionPrompt(operator, prompt.id, { action: "SUBMIT" });
		await transitionPrompt(marketing, prompt.id, { action: "APPROVE" });
		promptIds.push(prompt.id);
	}
	const [p1, p2] = promptIds;
	promptSetId = (await freezePromptSet(operator, (await createPromptSet(operator, { name: "基线", promptIds })).id)).id;

	const target = (platform: "deepseek" | "qwen") =>
		createSamplingTarget(admin, {
			platform,
			surfaceMode: "MODEL_API",
			provider: platform,
			modelId: "m",
			language: "zh-CN",
			config: { baseUrl: "https://model-api.example.test/v1", model: "m" },
			maxConcurrency: 1,
			enabled: false,
		});
	const deepseek = await target("deepseek");
	const qwen = await target("qwen");

	const [batch] = await db
		.insert(geoSamplingBatches)
		.values({
			organizationId,
			promptSetId,
			repeatCount: 3,
			plannedCount: 9,
			status: "PARTIAL",
			requestedBy: operator.actorId,
			idempotencyKey: randomUUID(),
		})
		.returning();
	const sampledAt = new Date(Date.now() - 60 * 60_000);

	async function sample(
		name: string,
		promptId: string,
		targetRow: typeof deepseek,
		repeatIndex: number,
		status: GeoRunStatus,
		judged?: Judged,
		retryOf?: string,
	) {
		const [run] = await db
			.insert(geoSamplingRuns)
			.values({
				organizationId,
				batchId: batch.id,
				promptId,
				targetId: targetRow.id,
				repeatIndex,
				status,
				idempotencyKey: retryOf
					? `${retryOf}:resample`
					: samplingRunIdempotencyKey({ batchId: batch.id, promptId, targetId: targetRow.id, repeatIndex }),
				retryOfRunId: retryOf ?? null,
				retryRelation: retryOf ? "EXPLICIT_RESAMPLE" : null,
			})
			.returning();
		ids[`${name}:run`] = run.id;
		const answered = status === "VALID";
		const [observation] = await db
			.insert(geoObservations)
			.values({
				organizationId,
				runId: run.id,
				promptId,
				promptSetId,
				promptRevision: 1,
				questionText: "问法",
				targetId: targetRow.id,
				platform: targetRow.platform,
				surfaceMode: "MODEL_API",
				status: status as never,
				responseText: answered ? "示例电气与样板开关都可以考虑。" : null,
				sampledAt,
			})
			.returning();
		ids[name] = observation.id;
		if (judged) ids[`${name}:evaluation`] = await insertEvaluation(observation.id, judged);
	}

	// deepseek: P1 three valid answers, P2 one pending recommendation, a timeout re-sampled to valid, a rate limit.
	await sample("p1a", p1, deepseek, 0, "VALID", {
		mentioned: true,
		recommendation: "RECOMMENDED",
		ordered: true,
		rank: 1,
		competitor: true,
		ownCitation: true,
	});
	await sample("p1b", p1, deepseek, 1, "VALID", {
		mentioned: true,
		recommendation: "MENTIONED_ONLY",
		ordered: true,
		rank: 4,
	});
	await sample("p1c", p1, deepseek, 2, "VALID", { mentioned: false, recommendation: "NOT_MENTIONED" });
	await sample("p2a", p2, deepseek, 0, "VALID", {
		mentioned: true,
		recommendation: "RECOMMENDED",
		ordered: true,
		rank: 2,
		pending: true,
		competitor: true,
	});
	await sample("p2b", p2, deepseek, 1, "TIMEOUT");
	await sample(
		"p2b-retry",
		p2,
		deepseek,
		1,
		"VALID",
		{ mentioned: true, recommendation: "MENTIONED_ONLY" },
		ids["p2b:run"],
	);
	await sample("p2c", p2, deepseek, 2, "RATE_LIMITED");
	// qwen: every attempt hit a verification wall.
	for (const repeat of [0, 1, 2]) await sample(`q${repeat}`, p1, qwen, repeat, "CAPTCHA");

	const claim = async (
		name: string,
		verdict: "UNVERIFIED" | "CORRECT",
		matchStatus: "MISMATCH" | "MATCHED" | "NO_REFERENCE",
	) => {
		const [row] = await db
			.insert(geoObservationClaims)
			.values({
				organizationId,
				observationId: ids[name],
				evaluationId: ids[`${name}:evaluation`],
				claimText: "额定电压 12kV",
				verdict,
				matchStatus,
			})
			.returning();
		ids[`${name}:claim`] = row.id;
	};
	await claim("p1a", "UNVERIFIED", "MISMATCH");
	await claim("p1b", "CORRECT", "MATCHED");
	await claim("p2a", "UNVERIFIED", "MISMATCH");
});

describe("review pool", () => {
	it("lists the evaluation waiting for a person with the claim that disagrees with approved knowledge", async () => {
		const { rows, total } = await listReviewPool(marketing, {}, { page: 1, limit: 20, offset: 0 });
		expect(total).toBe(1);
		expect(rows[0]).toMatchObject({
			observationId: ids.p2a,
			reviewReasons: ["LOW_CONFIDENCE"],
			pendingClaims: 1,
		});
		const filtered = await listReviewPool(marketing, { reason: "CLAIM_MISMATCH" }, { page: 1, limit: 20, offset: 0 });
		expect(filtered.total).toBe(0);
		const overview = await getOverview(operator);
		expect(overview.pending.reviewPool).toBe(1);
		// Seven stored answers, but a timeout and its re-sample are one planned slot.
		expect(overview.recent.cells.find((cell) => cell.platform === "deepseek")).toMatchObject({
			total: 6,
			valid: 5,
			notValid: 1,
			evaluated: 5,
		});
	});

	it("gives headline figures per surface mode, with a mixed figure only when it is asked for", async () => {
		const plain = await getOverview(operator);
		expect(plain.insights.overview.crossMode).toBeNull();
		expect(plain.insights.overview.bySurfaceMode.map((mode) => mode.surfaceMode)).toEqual(["MODEL_API"]);
		const [api] = plain.insights.overview.bySurfaceMode;
		expect(api?.mention).toMatchObject({ weighting: "EQUAL", cellsIncluded: 1, cellsWithoutData: 1 });
		expect(api?.mention.value).toMatchObject({ status: "OK" });

		const mixed = await getOverview(operator, { crossMode: true });
		expect(mixed.insights.overview.crossMode?.mention.note).toContain("跨采样方式");
	});
});

describe("observation review", () => {
	it("appends a new current version for a confirmation and keeps the original", async () => {
		const evaluationId = ids["p2a:evaluation"];
		await expectGeoError(
			submitObservationReview(operator, ids.p2a, {
				type: "evaluation",
				decision: "CONFIRM",
				expectedEvaluationId: evaluationId,
			}),
			"FORBIDDEN",
		);
		const review = await submitObservationReview(marketing, ids.p2a, {
			type: "evaluation",
			decision: "CONFIRM",
			expectedEvaluationId: evaluationId,
		});
		expect(review.evaluations.map((row) => [row.version, row.reviewStatus, row.isCurrent])).toEqual(
			expect.arrayContaining([
				[1, "PENDING_REVIEW", false],
				[2, "CONFIRMED", true],
			]),
		);
		// The version the reviewer saw is no longer current, so a second review of it is refused.
		await expectGeoError(
			submitObservationReview(tech, ids.p2a, {
				type: "evaluation",
				decision: "CONFIRM",
				expectedEvaluationId: evaluationId,
			}),
			"CONFLICT",
		);
	});

	it("refuses a reviewer confirming their own correction", async () => {
		const corrected = await submitObservationReview(marketing, ids.p1c, {
			type: "evaluation",
			decision: "CORRECT",
			expectedEvaluationId: ids["p1c:evaluation"],
			brandMentioned: true,
			recommendation: "MENTIONED_ONLY",
			reason: "回答末尾提到了品牌简称",
		});
		const current = corrected.evaluations.find((row) => row.isCurrent);
		expect(current).toMatchObject({ version: 2, reviewStatus: "CORRECTED", brandMentioned: true });
		await expectGeoError(
			submitObservationReview(marketing, ids.p1c, {
				type: "evaluation",
				decision: "CONFIRM",
				expectedEvaluationId: current?.id as string,
			}),
			"FORBIDDEN",
		);
		// Undo the correction through a second reviewer so the metrics below read the original judgement.
		await submitObservationReview(tech, ids.p1c, {
			type: "evaluation",
			decision: "CORRECT",
			expectedEvaluationId: current?.id as string,
			brandMentioned: false,
			recommendation: "NOT_MENTIONED",
			reason: "简称属于另一家公司",
		});
		const rows = await db.select().from(geoEvaluations).where(eq(geoEvaluations.observationId, ids.p1c));
		expect(rows.filter((row) => row.isCurrent)).toHaveLength(1);
		expect(rows).toHaveLength(3);
	});

	it("lets only a technical reviewer settle a claim, with a basis for an error", async () => {
		const claimId = ids["p1a:claim"];
		await expectGeoError(
			submitObservationReview(marketing, ids.p1a, { type: "claim", claimId, verdict: "ERROR", note: "参数不符" }),
			"FORBIDDEN",
		);
		await expect(
			submitObservationReview(tech, ids.p1a, { type: "claim", claimId, verdict: "ERROR" }),
		).rejects.toThrow();
		const review = await submitObservationReview(tech, ids.p1a, {
			type: "claim",
			claimId,
			verdict: "ERROR",
			note: "铭牌为 24kV",
		});
		expect(review.claims[0]).toMatchObject({ verdict: "ERROR", reviewerId: tech.actorId });
		expect((await getObservationReview(operator, ids.p1a)).claims).toHaveLength(1);
	});
});

describe("metrics on stored evidence", () => {
	it("computes every PRD 5.2 metric per platform and mode with failures outside the denominators", async () => {
		const { insights, meta } = await getInsights(operator, {});
		expect(meta.promptSet?.id).toBe(promptSetId);
		const deepseek = insights.cells.find((cell) => cell.platform === "deepseek");
		const qwen = insights.cells.find((cell) => cell.platform === "qwen");

		// Six planned slots: the timeout and its re-sample are one slot, and the re-sample answered.
		expect(deepseek?.validSampleRate.breakdown).toMatchObject({ planned: 6, valid: 5, rateLimited: 1, failed: 0 });
		expect(deepseek?.validSampleRate.value).toMatchObject({ numerator: 5, denominator: 6 });
		expect(deepseek?.mentionRate).toMatchObject({ status: "OK", numerator: 4, denominator: 5, lowSample: true });
		expect(deepseek?.recommendationRate).toMatchObject({ numerator: 2, denominator: 5 });
		expect(deepseek?.recommendationsAwaitingReview).toBe(0);
		expect(deepseek?.top3Rate).toMatchObject({ numerator: 2, denominator: 3 });
		expect(deepseek?.stableMention).toMatchObject({
			stableUnits: 1,
			sufficientUnits: 1,
			insufficientUnits: 1,
			value: { status: "OK", numerator: 1, denominator: 1 },
		});
		expect(deepseek?.competitors).toEqual([
			expect.objectContaining({
				entityId: competitorId,
				mentioned: expect.objectContaining({ numerator: 2, denominator: 5 }),
			}),
		]);
		expect(deepseek?.citations).toMatchObject({ status: "OK", totalCitations: 1, byOwner: { OWN: 1 } });
		expect(deepseek?.errorRate).toMatchObject({
			confirmedErrors: 1,
			checkable: 2,
			awaitingTechReview: 1,
			value: { numerator: 1, denominator: 2 },
		});

		// Nothing answered on qwen: its rates read as missing data, never as 0%.
		expect(qwen?.validSampleRate.breakdown).toMatchObject({ planned: 3, valid: 0, refused: 3 });
		expect(qwen?.mentionRate.status).toBe("NO_DATA");
		expect(qwen?.recommendationRate.status).toBe("NO_DATA");
		expect(qwen?.top3Rate.status).toBe("NO_DATA");
		expect(qwen?.stableMention.value.status).toBe("NO_DATA");
		expect(qwen?.errorRate.value.status).toBe("NO_DATA");
		expect(qwen?.citations.status).toBe("NOT_PROVIDED");

		expect(insights.totals).toMatchObject({ planned: 9, valid: 5, evaluated: 5 });
	});

	it("lists confirmed errors before unreviewed mismatches, and the evidence behind them", async () => {
		const issues = await listClaimIssues(operator, { promptSetId });
		expect(issues.map((issue) => [issue.observationId, issue.verdict])).toEqual([
			[ids.p1a, "ERROR"],
			[ids.p2a, "UNVERIFIED"],
		]);
		const { rows, total } = await listObservations(
			operator,
			{ promptSetId, platform: "deepseek" },
			{ page: 1, limit: 50, offset: 0 },
		);
		expect(total).toBe(7);
		expect(rows.find((row) => row.id === ids.p2a)?.evaluation).toMatchObject({
			reviewStatus: "CONFIRMED",
			recommendation: "RECOMMENDED",
		});
		const detail = await getObservation(operator, ids["p2b-retry"]);
		expect(detail).toMatchObject({ id: ids["p2b-retry"], status: "VALID" });
	});

	it("reads only the current evaluation after a review", async () => {
		const current = await db
			.select()
			.from(geoEvaluations)
			.where(and(eq(geoEvaluations.observationId, ids.p2a), eq(geoEvaluations.isCurrent, true)));
		expect(current).toHaveLength(1);
		expect(current[0]?.reviewStatus).toBe("CONFIRMED");
	});
});
