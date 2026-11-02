import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { GeoPrincipal } from "@workspace/geo-domain";
import { db } from "@workspace/lib/db/db";
import { geoObservations, geoOrgSettings, geoSamplingRuns } from "@workspace/lib/db/schema";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listCredentials } from "@/server/geo/admin-core";
import { importManualObservations } from "@/server/geo/observations-import-core";
import {
	createPrompt,
	createPromptSet,
	freezePromptSet,
	listBuyerRoles,
	transitionPrompt,
} from "@/server/geo/prompts-core";
import { createSamplingBatch, resampleRun } from "@/server/geo/sampling-core";
import {
	createSamplingTarget,
	setSamplingTargetCredential,
	setSamplingTargetVerification,
} from "@/server/geo/sampling-targets-core";
import { createGeoOrganization, expectGeoError } from "@/test/integration/geo-fixtures";

let organizationId: string;
let operator: GeoPrincipal;
let admin: GeoPrincipal;
let frozenSetId: string;
let draftSetId: string;
let promptIds: string[];
let objectRoot: string;

const MODEL_API_CONFIG = { baseUrl: "https://model-api.example.test/v1", model: "test-model" };

beforeAll(async () => {
	process.env.ELMO_ENCRYPTION_KEY ??= Buffer.alloc(32, 9).toString("base64");
	objectRoot = await mkdtemp(path.join(tmpdir(), "geo-objects-"));
	process.env.GEO_OBJECT_STORE_URL = `file://${objectRoot}`;

	const org = await createGeoOrganization();
	organizationId = org.organizationId;
	operator = await org.actor(["geo_operator"]);
	admin = await org.actor(["platform_admin"]);
	const reviewer = await org.actor(["marketing_reviewer"]);
	const [role] = await listBuyerRoles(operator);
	const labels = { buyerRoleId: role?.id, intent: "选型", productLine: "开关柜", geoRegion: "华东" };
	promptIds = [];
	for (const question of ["高低压开关柜哪家好？", "环网柜厂家推荐"]) {
		const prompt = await createPrompt(operator, { question, ...labels });
		await transitionPrompt(operator, prompt.id, { action: "SUBMIT" });
		await transitionPrompt(reviewer, prompt.id, { action: "APPROVE" });
		promptIds.push(prompt.id);
	}
	const set = await createPromptSet(operator, { name: "基线", promptIds });
	frozenSetId = (await freezePromptSet(operator, set.id)).id;
	draftSetId = (await createPromptSet(operator, { name: "草稿", promptIds })).id;
});

afterAll(async () => {
	await rm(objectRoot, { recursive: true, force: true });
});

async function modelApiTarget(verified: boolean) {
	const target = await createSamplingTarget(admin, {
		platform: "deepseek",
		surfaceMode: "MODEL_API",
		provider: "deepseek",
		modelId: "test-model",
		language: "zh-CN",
		config: MODEL_API_CONFIG,
		maxConcurrency: 1,
		enabled: true,
	});
	if (verified) await setSamplingTargetVerification(admin, target.id, { status: "PASSED", note: "已用测试账号验证" });
	return target;
}

describe("planning a sampling batch", () => {
	it("plans one run per prompt, target and repeat, once per idempotency key", async () => {
		const unverified = await modelApiTarget(false);
		const target = await modelApiTarget(true);
		await expectGeoError(
			createSamplingBatch(operator, { promptSetId: frozenSetId, targetIds: [unverified.id], repeatCount: 3 }),
			"TARGET_UNAVAILABLE",
		);
		await expectGeoError(
			createSamplingBatch(operator, { promptSetId: draftSetId, targetIds: [target.id], repeatCount: 3 }),
			"CONFLICT",
		);

		const input = { promptSetId: frozenSetId, targetIds: [target.id], repeatCount: 3, idempotencyKey: "round-1" };
		const first = await createSamplingBatch(operator, input);
		const again = await createSamplingBatch(operator, input);
		expect(first.created).toBe(true);
		expect(again).toMatchObject({ created: false, batch: { id: first.batch.id } });
		const runs = await db.select().from(geoSamplingRuns).where(eq(geoSamplingRuns.batchId, first.batch.id));
		expect(runs).toHaveLength(6);
		expect(first.batch.plannedCount).toBe(6);
		expect(new Set(runs.map((run) => `${run.promptId}:${run.repeatIndex}`)).size).toBe(6);

		// A re-sample is a new run on a finished slot, and only one per run.
		await expectGeoError(resampleRun(operator, runs[0].id, { reason: "平台抖动" }), "CONFLICT");
		await db.update(geoSamplingRuns).set({ status: "TIMEOUT" }).where(eq(geoSamplingRuns.id, runs[0].id));
		const { runId } = await resampleRun(operator, runs[0].id, { reason: "平台抖动" });
		const [resample] = await db.select().from(geoSamplingRuns).where(eq(geoSamplingRuns.id, runId));
		expect(resample).toMatchObject({
			retryOfRunId: runs[0].id,
			retryRelation: "EXPLICIT_RESAMPLE",
			promptId: runs[0].promptId,
			repeatIndex: runs[0].repeatIndex,
		});
		await expectGeoError(resampleRun(operator, runs[0].id, { reason: "平台抖动" }), "CONFLICT");
	});

	it("refuses a batch over the organization's per-batch limit", async () => {
		const target = await modelApiTarget(true);
		await db
			.insert(geoOrgSettings)
			.values({ organizationId, samplingBatchLimit: 4 })
			.onConflictDoUpdate({
				target: geoOrgSettings.organizationId,
				set: { samplingBatchLimit: 4 },
			});
		try {
			await expectGeoError(
				createSamplingBatch(operator, { promptSetId: frozenSetId, targetIds: [target.id], repeatCount: 3 }),
				"RATE_LIMITED",
			);
		} finally {
			await db
				.update(geoOrgSettings)
				.set({ samplingBatchLimit: null })
				.where(eq(geoOrgSettings.organizationId, organizationId));
		}
	});

	it("keeps a target's own credential out of the settings page's missing references", async () => {
		const target = await modelApiTarget(true);
		await setSamplingTargetCredential(admin, target.id, "sk-test-0123456789");
		const { missingRefs } = await listCredentials(admin);
		expect(missingRefs).toEqual([]);
	});
});

describe("manual evidence import", () => {
	let manualTargetId: string;

	beforeAll(async () => {
		const target = await createSamplingTarget(admin, {
			platform: "doubao",
			surfaceMode: "MANUAL_EVIDENCE",
			provider: "manual",
			language: "zh-CN",
			config: {},
			maxConcurrency: 1,
			enabled: true,
		});
		manualTargetId = target.id;
	});

	const row = (question: string, responseText: string) => ({
		sampledAt: "2026-10-30T08:00:00Z",
		platform: "doubao",
		question,
		responseText,
		evidenceLocation: "共享盘/截图/2026-10-30-01.png",
		citations: [{ url: "https://www.example-electric.test/cases/1" }],
	});

	it("imports nothing from a file with a row missing its evidence and says which row", async () => {
		const result = await importManualObservations(operator, {
			format: "rows",
			promptSetId: frozenSetId,
			rows: [row("高低压开关柜哪家好？", "示例电气较常见。"), { ...row("环网柜厂家推荐", "略"), evidenceLocation: "" }],
		});
		expect(result).toMatchObject({ ok: false, code: "EVIDENCE_REQUIRED" });
		if (!result.ok)
			expect(result.errors.map((error) => [error.row, error.field])).toContainEqual([2, "evidenceLocation"]);
		const imported = await db
			.select()
			.from(geoObservations)
			.where(and(eq(geoObservations.organizationId, organizationId), eq(geoObservations.targetId, manualTargetId)));
		expect(imported).toHaveLength(0);
	});

	it("imports valid rows once, even when the same file is sent twice at the same time", async () => {
		const input = {
			format: "rows" as const,
			promptSetId: frozenSetId,
			rows: [row("高低压开关柜哪家好？", "示例电气较常见。"), row("环网柜厂家推荐", "可以看看示例电气。")],
		};
		const results = await Promise.all([
			importManualObservations(operator, input),
			importManualObservations(operator, input),
		]);
		expect(results.map((result) => result.ok)).toEqual([true, true]);
		const imported = await db
			.select()
			.from(geoObservations)
			.where(and(eq(geoObservations.organizationId, organizationId), eq(geoObservations.targetId, manualTargetId)));
		expect(imported).toHaveLength(2);
		expect(imported[0]).toMatchObject({ surfaceMode: "MANUAL_EVIDENCE", status: "VALID", promptSetId: frozenSetId });

		const replay = await importManualObservations(operator, input);
		expect(replay).toMatchObject({ ok: true, created: 0, skipped: 2 });
	});
});
