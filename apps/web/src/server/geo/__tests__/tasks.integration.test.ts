import { randomUUID } from "node:crypto";
import { type GeoPrincipal, samplingRunIdempotencyKey } from "@workspace/geo-domain";
import { db } from "@workspace/lib/db/db";
import {
	geoEvaluations,
	geoObservations,
	geoSamplingBatches,
	geoSamplingRuns,
	geoTaskEvents,
	geoTaskEvidence,
} from "@workspace/lib/db/schema";
import { linkGeoRetestBatches } from "@workspace/lib/geo/maintenance";
import { asc, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import {
	createPrompt,
	createPromptSet,
	freezePromptSet,
	listBuyerRoles,
	transitionPrompt,
} from "@/server/geo/prompts-core";
import { createSamplingTarget } from "@/server/geo/sampling-targets-core";
import {
	createTask,
	getTaskDetail,
	listBoardTasks,
	listTaskBatches,
	listTasks,
	transitionTask,
} from "@/server/geo/tasks-core";
import { createGeoOrganization, expectGeoError } from "@/test/integration/geo-fixtures";

let operator: GeoPrincipal;
let owner: GeoPrincipal;
let tech: GeoPrincipal;
let marketing: GeoPrincipal;
let promptId: string;
let promptSetId: string;
let targetId: string;
let organizationId: string;
let baselineBatchId: string;
let baselineObservationId: string;

/** One settled round of three answers on the frozen set, `mentioned` of which name the brand. */
async function settledRound(createdAt: Date, mentioned: number) {
	const [batch] = await db
		.insert(geoSamplingBatches)
		.values({
			organizationId,
			promptSetId,
			repeatCount: 3,
			plannedCount: 3,
			validCount: 3,
			status: "COMPLETED",
			requestedBy: operator.actorId,
			idempotencyKey: randomUUID(),
			createdAt,
		})
		.returning();
	const observationIds: string[] = [];
	for (const repeatIndex of [0, 1, 2]) {
		const [run] = await db
			.insert(geoSamplingRuns)
			.values({
				organizationId,
				batchId: batch.id,
				promptId,
				targetId,
				repeatIndex,
				status: "VALID",
				idempotencyKey: samplingRunIdempotencyKey({ batchId: batch.id, promptId, targetId, repeatIndex }),
			})
			.returning();
		const [observation] = await db
			.insert(geoObservations)
			.values({
				organizationId,
				runId: run.id,
				promptId,
				promptSetId,
				promptRevision: 1,
				questionText: "高低压开关柜哪家好？",
				targetId,
				platform: "deepseek",
				surfaceMode: "MODEL_API",
				status: "VALID",
				responseText: "回答",
				sampledAt: createdAt,
			})
			.returning();
		observationIds.push(observation.id);
		const named = repeatIndex < mentioned;
		await db.insert(geoEvaluations).values({
			organizationId,
			observationId: observation.id,
			version: 1,
			evaluatorVersion: "rules-test",
			brandMentioned: named,
			recommendation: named ? "MENTIONED_ONLY" : "NOT_MENTIONED",
			reviewStatus: "AUTO_ACCEPTED",
			createdBy: "system:evaluation",
		});
	}
	return { batchId: batch.id, observationIds };
}

beforeAll(async () => {
	const org = await createGeoOrganization();
	organizationId = org.organizationId;
	operator = await org.actor(["geo_operator", "tech_reviewer"]);
	owner = await org.actor(["geo_operator"]);
	tech = await org.actor(["tech_reviewer"]);
	marketing = await org.actor(["marketing_reviewer"]);
	const admin = await org.actor(["platform_admin"]);

	const [role] = await listBuyerRoles(operator);
	const prompt = await createPrompt(operator, {
		question: "高低压开关柜哪家好？",
		buyerRoleId: role?.id,
		intent: "选型",
		productLine: "开关柜",
		geoRegion: "华东",
	});
	await transitionPrompt(operator, prompt.id, { action: "SUBMIT" });
	await transitionPrompt(marketing, prompt.id, { action: "APPROVE" });
	promptId = prompt.id;
	promptSetId = (
		await freezePromptSet(operator, (await createPromptSet(operator, { name: "基线", promptIds: [promptId] })).id)
	).id;
	targetId = (
		await createSamplingTarget(admin, {
			platform: "deepseek",
			surfaceMode: "MODEL_API",
			provider: "deepseek",
			modelId: "m",
			language: "zh-CN",
			config: { baseUrl: "https://model-api.example.test/v1", model: "m" },
			maxConcurrency: 1,
			enabled: false,
		})
	).id;
	const baseline = await settledRound(new Date(Date.now() - 2 * 86_400_000), 1);
	baselineBatchId = baseline.batchId;
	baselineObservationId = baseline.observationIds[2] as string;
});

describe("optimization tasks", () => {
	it("is created once per source and only with the evidence it came from", async () => {
		const input = {
			title: "补充开关柜选型 FAQ",
			kind: "FAQ" as const,
			sourceKind: "OBSERVATION" as const,
			sourceRef: `observation:${baselineObservationId}`,
			promptId,
			beforeBatchId: baselineBatchId,
			evidence: { observationIds: [baselineObservationId] },
		};
		await expectGeoError(createTask(operator, { ...input, evidence: {} }), "EVIDENCE_REQUIRED");
		const first = await createTask(operator, input);
		const again = await createTask(owner, input);
		expect(first.created).toBe(true);
		expect(again).toMatchObject({ created: false, task: { id: first.task.id } });
		const evidence = await db.select().from(geoTaskEvidence).where(eq(geoTaskEvidence.taskId, first.task.id));
		expect(evidence.map((row) => row.observationId)).toEqual([baselineObservationId]);
	});

	it("walks every state from analysis to verified, with publication proof and a retest comparison", async () => {
		const { task } = await createTask(operator, {
			title: "官网增加 XG-900 案例",
			kind: "CASE_ADDITION",
			sourceKind: "MANUAL",
			riskLevel: "HIGH",
			promptId,
			beforeBatchId: baselineBatchId,
		});
		const step = (principal: GeoPrincipal, input: Parameters<typeof transitionTask>[2]) =>
			transitionTask(principal, task.id, input);

		await step(operator, { action: "TRIAGE" });
		await expectGeoError(step(operator, { action: "ASSIGN" }), "VALIDATION_ERROR");
		await step(operator, { action: "ASSIGN", ownerId: owner.actorId });
		await step(owner, { action: "SUBMIT_FOR_REVIEW" });
		// The author holds the technical review role, but a high-risk task is never reviewed by its author.
		await expectGeoError(step(operator, { action: "APPROVE_TECH" }), "FORBIDDEN");
		await expectGeoError(step(tech, { action: "REJECT" }), "VALIDATION_ERROR");
		await step(tech, { action: "REJECT", comment: "案例缺少项目地点" });
		await step(owner, { action: "REWORK" });
		await step(owner, { action: "SUBMIT_FOR_REVIEW" });
		await step(tech, { action: "APPROVE_TECH" });
		await step(marketing, { action: "APPROVE_MARKETING" });

		const publishedAt = new Date().toISOString();
		await expectGeoError(
			step(owner, { action: "PUBLISH", publishedUrl: "https://www.example-electric.test/cases/xg900", publishedAt }),
			"EVIDENCE_REQUIRED",
		);
		const published = await step(owner, {
			action: "PUBLISH",
			publishedUrl: "https://www.example-electric.test/cases/xg900",
			publishedAt,
			proofNote: "官网后台发布记录截图",
		});
		expect(published).toMatchObject({
			state: "PUBLISHED",
			publishedUrl: "https://www.example-electric.test/cases/xg900",
		});
		await step(owner, { action: "REQUEST_RETEST" });
		await expectGeoError(step(owner, { action: "VERIFY" }), "EVIDENCE_REQUIRED");

		const retest = await settledRound(new Date(Date.now() + 1000), 3);
		expect(await linkGeoRetestBatches(db)).toBeGreaterThanOrEqual(1);
		const detail = await getTaskDetail(operator, task.id);
		expect(detail.task.afterBatchId).toBe(retest.batchId);
		expect(detail.comparison?.rows).toEqual([
			expect.objectContaining({
				platform: "deepseek",
				before: expect.objectContaining({ mentionRate: expect.objectContaining({ numerator: 1, denominator: 3 }) }),
				after: expect.objectContaining({ mentionRate: expect.objectContaining({ numerator: 3, denominator: 3 }) }),
			}),
		]);

		expect(await step(owner, { action: "VERIFY", comment: "提及率上升，待下一轮确认" })).toMatchObject({
			state: "VERIFIED",
		});
		const events = await db
			.select()
			.from(geoTaskEvents)
			.where(eq(geoTaskEvents.taskId, task.id))
			.orderBy(asc(geoTaskEvents.createdAt));
		expect(events.map((event) => event.toState)).toEqual([
			"PENDING_ANALYSIS",
			"PENDING_ASSIGNMENT",
			"IN_PROGRESS",
			"PENDING_TECH_REVIEW",
			"REJECTED",
			"IN_PROGRESS",
			"PENDING_TECH_REVIEW",
			"PENDING_MARKETING_REVIEW",
			"PENDING_PUBLISH",
			"PUBLISHED",
			"PENDING_RETEST",
			"PENDING_RETEST",
			"VERIFIED",
		]);
		await expectGeoError(step(owner, { action: "CANCEL", comment: "已完成" }), "CONFLICT");
	});

	it("lists tasks for the table and the board, and the batches a task can point at", async () => {
		const verified = await listTasks(operator, { state: ["VERIFIED"] }, { limit: 20, offset: 0 });
		expect(verified.total).toBe(1);
		const open = await listTasks(operator, { q: "FAQ" }, { limit: 20, offset: 0 });
		expect(open.rows.map((row) => row.title)).toEqual(["补充开关柜选型 FAQ"]);
		const board = await listBoardTasks(operator);
		expect(board.rows.length).toBe(2);
		expect((await listTaskBatches(operator)).length).toBe(2);
	});
});
