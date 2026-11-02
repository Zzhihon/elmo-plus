import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { GeoPrincipal } from "@workspace/geo-domain";
import { db } from "@workspace/lib/db/db";
import { geoObservations, geoOrgSettings, geoSamplingRuns } from "@workspace/lib/db/schema";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { listCredentials } from "@/server/geo/admin-core";
import {
	exportObservation,
	getObservation,
	listObservations,
	readObservationEvidence,
} from "@/server/geo/observations-core";
import { importManualObservations } from "@/server/geo/observations-import-core";
import {
	createPrompt,
	createPromptSet,
	exportPromptsCsv,
	freezePromptSet,
	importPromptsCsv,
	listBuyerRoles,
	listPrompts,
	promptRoleCoverage,
	promptStatusCounts,
	transitionPrompt,
} from "@/server/geo/prompts-core";
import {
	createSamplingBatch,
	getSamplingBatch,
	listFrozenPromptSets,
	listSamplingBatches,
	resampleRun,
} from "@/server/geo/sampling-core";
import {
	createSamplingTarget,
	listSamplingTargets,
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
	vi.stubEnv("ELMO_ENCRYPTION_KEY", Buffer.alloc(32, 9).toString("base64"));
	objectRoot = await mkdtemp(path.join(tmpdir(), "geo-objects-"));
	vi.stubEnv("GEO_OBJECT_STORE_URL", `file://${objectRoot}`);

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

		const listed = await listSamplingBatches(operator, { page: 1, limit: 20, offset: 0 });
		expect(listed.rows.find((row) => row.id === first.batch.id)).toMatchObject({ targetCount: 1, plannedCount: 6 });
		const detail = await getSamplingBatch(operator, first.batch.id, { page: 1, limit: 50, offset: 0 });
		expect(detail).toBeTruthy();
		expect((await listFrozenPromptSets(operator)).find((set) => set.id === frozenSetId)?.itemCount).toBe(2);
		const targets = await listSamplingTargets(operator);
		expect(targets.find((row) => row.id === target.id)).toMatchObject({ runnable: true, credentialConfigured: false });
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

		const { rows } = await listObservations(operator, { targetId: manualTargetId }, { page: 1, limit: 20, offset: 0 });
		expect(rows).toHaveLength(2);
		expect(rows[0]).toMatchObject({ imported: true, citationCount: 1 });
		const detail = await getObservation(operator, rows[0].id);
		expect(detail.target.surfaceMode).toBe("MANUAL_EVIDENCE");
		const exported = await exportObservation(operator, rows[0].id);
		expect(exported.method.note).toContain("人工采样");
		// A location outside the object store is shown as written, never fetched.
		await expectGeoError(readObservationEvidence(operator, rows[0].id), "NOT_FOUND");
	});
});

describe("the prompt library", () => {
	it("exports its CSV, imports new rows from it as drafts, and counts statuses and role coverage", async () => {
		const csv = await exportPromptsCsv(operator, {});
		expect(csv).toContain("高低压开关柜哪家好？");
		const [header] = csv.replace(/^\uFEFF/, "").split(/\r?\n/);
		const columns = (header as string).split(",");
		const row: Record<string, string> = {
			question: "开关柜厂家售后服务怎么样",
			buyer_role: "procurement",
			intent: "售后",
			product_line: "开关柜",
			geo_region: "华东",
			priority: "P2",
			language: "zh-CN",
			tier: "CORE",
		};
		const roles = await listBuyerRoles(operator);
		row.buyer_role = roles[0]?.code ?? "";
		const result = await importPromptsCsv(
			operator,
			`${header}\n${columns.map((column) => row[column.replace(/"/g, "")] ?? "").join(",")}\n`,
		);
		expect(result).toMatchObject({ created: 1, errors: [] });
		const { total } = await listPrompts(operator, { status: "FROZEN" }, { limit: 50, offset: 0 });
		expect(total).toBe(2);
		expect(await promptStatusCounts(operator)).toMatchObject({ FROZEN: 2, DRAFT: 1 });
		expect((await promptRoleCoverage(operator)).length).toBeGreaterThan(0);
	});
});
