import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { GeoPrincipal } from "@workspace/geo-domain";
import { getObjectStore } from "@workspace/geo-evidence";
import { db } from "@workspace/lib/db/db";
import { geoEvidenceUploads, geoObservations, geoOrgSettings, geoSamplingRuns, secrets } from "@workspace/lib/db/schema";
import { and, count, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { listCredentials } from "@/server/geo/admin-core";
import {
	exportObservation,
	getObservation,
	listObservations,
	readObservationEvidence,
} from "@/server/geo/observations-core";
import { importManualObservations, uploadEvidenceFile } from "@/server/geo/observations-import-core";
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
	checkSamplingTargetConnectivity,
	createSamplingTarget,
	listSamplingTargets,
	loadTarget,
	setSamplingTargetCredential,
	setSamplingTargetVerification,
	type TargetInput,
	updateSamplingTarget,
} from "@/server/geo/sampling-targets-core";
import { createGeoOrganization, expectGeoError } from "@/test/integration/geo-fixtures";

let geoOrg: Awaited<ReturnType<typeof createGeoOrganization>>;
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
	geoOrg = org;
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

	it("samples only core questions unless extended ones are explicitly included, and records which", async () => {
		const reviewer = await geoOrg.actor(["marketing_reviewer"]);
		const [role] = await listBuyerRoles(operator);
		const labels = { buyerRoleId: role?.id, intent: "选型", productLine: "开关柜", geoRegion: "华东" };
		const prompt = await createPrompt(operator, { question: "环网柜维护周期", tier: "EXTENDED", ...labels });
		await transitionPrompt(operator, prompt.id, { action: "SUBMIT" });
		await transitionPrompt(reviewer, prompt.id, { action: "APPROVE" });
		const mixed = await createPromptSet(operator, { name: "含扩展", promptIds: [...promptIds, prompt.id] });
		const setId = (await freezePromptSet(operator, mixed.id)).id;
		const target = await modelApiTarget(true);
		const base = { promptSetId: setId, targetIds: [target.id], repeatCount: 1 };

		const core = await createSamplingBatch(operator, base);
		expect(core.batch).toMatchObject({ includesExtended: false, plannedCount: 2 });
		const coreRuns = await db.select().from(geoSamplingRuns).where(eq(geoSamplingRuns.batchId, core.batch.id));
		expect(coreRuns.map((run) => run.promptId)).not.toContain(prompt.id);

		const all = await createSamplingBatch(operator, { ...base, includeExtended: true });
		expect(all.batch).toMatchObject({ includesExtended: true, plannedCount: 3 });
		const allRuns = await db.select().from(geoSamplingRuns).where(eq(geoSamplingRuns.batchId, all.batch.id));
		expect(allRuns.map((run) => run.promptId)).toContain(prompt.id);

		const listedSets = await listFrozenPromptSets(operator);
		expect(listedSets.find((set) => set.id === setId)).toMatchObject({ itemCount: 3, coreCount: 2, extendedCount: 1 });
		const listed = await listSamplingBatches(operator, { page: 1, limit: 50, offset: 0 });
		expect(listed.rows.find((row) => row.id === all.batch.id)?.includesExtended).toBe(true);
	});

	it("refuses a set with no core question unless extended ones are included", async () => {
		const reviewer = await geoOrg.actor(["marketing_reviewer"]);
		const [role] = await listBuyerRoles(operator);
		const labels = { buyerRoleId: role?.id, intent: "选型", productLine: "开关柜", geoRegion: "华东" };
		const prompt = await createPrompt(operator, { question: "开关柜备件怎么储存", tier: "EXTENDED", ...labels });
		await transitionPrompt(operator, prompt.id, { action: "SUBMIT" });
		await transitionPrompt(reviewer, prompt.id, { action: "APPROVE" });
		const set = await createPromptSet(operator, { name: "仅扩展", promptIds: [prompt.id] });
		const setId = (await freezePromptSet(operator, set.id)).id;
		const target = await modelApiTarget(true);
		await expectGeoError(
			createSamplingBatch(operator, { promptSetId: setId, targetIds: [target.id], repeatCount: 1 }),
			"VALIDATION_ERROR",
		);
		const result = await createSamplingBatch(operator, {
			promptSetId: setId,
			targetIds: [target.id],
			repeatCount: 1,
			includeExtended: true,
		});
		expect(result.batch.plannedCount).toBe(1);
	});

	it("holds concurrent batches to the daily limit and counts runs not yet started against the budget", async () => {
		const target = await modelApiTarget(true);
		const priced = await updateSamplingTarget(admin, target.id, {
			platform: "deepseek",
			surfaceMode: "MODEL_API",
			provider: "deepseek",
			modelId: "test-model",
			language: "zh-CN",
			config: { ...MODEL_API_CONFIG, pricing: { perRequest: 1 } },
			maxConcurrency: 1,
			enabled: true,
		});
		await setSamplingTargetVerification(admin, priced.id, { status: "PASSED", note: "已用测试账号验证" });
		const [{ value: already }] = await db
			.select({ value: count() })
			.from(geoSamplingRuns)
			.where(eq(geoSamplingRuns.organizationId, organizationId));
		const plan = { promptSetId: frozenSetId, targetIds: [priced.id], repeatCount: 1 };
		await db
			.insert(geoOrgSettings)
			.values({ organizationId, samplingDailyLimit: already + 2 })
			.onConflictDoUpdate({ target: geoOrgSettings.organizationId, set: { samplingDailyLimit: already + 2 } });
		try {
			const results = await Promise.allSettled([
				createSamplingBatch(operator, plan),
				createSamplingBatch(operator, plan),
			]);
			expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
		} finally {
			await db
				.update(geoOrgSettings)
				.set({ samplingDailyLimit: null })
				.where(eq(geoOrgSettings.organizationId, organizationId));
		}

		const [{ value: reserved }] = await db
			.select({ value: count() })
			.from(geoSamplingRuns)
			.where(and(eq(geoSamplingRuns.organizationId, organizationId), eq(geoSamplingRuns.targetId, priced.id)));
		await db
			.update(geoOrgSettings)
			.set({ samplingCostBudget: String(reserved + 1) })
			.where(eq(geoOrgSettings.organizationId, organizationId));
		try {
			await expectGeoError(createSamplingBatch(operator, plan), "RATE_LIMITED");
		} finally {
			await db
				.update(geoOrgSettings)
				.set({ samplingCostBudget: null })
				.where(eq(geoOrgSettings.organizationId, organizationId));
		}
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

describe("a target's endpoint and stored credential", () => {
	const input = (config: Record<string, unknown>): TargetInput => ({
		platform: "deepseek",
		surfaceMode: "MODEL_API",
		provider: "deepseek",
		modelId: "test-model",
		language: "zh-CN",
		config,
		maxConcurrency: 1,
		enabled: true,
	});
	const publicAddress = async () => [{ address: "93.184.216.34", family: 4 as const }];

	it("refuses an endpoint that names an address or an unusual port when it is saved", async () => {
		const target = await modelApiTarget(false);
		for (const baseUrl of ["https://10.0.0.8/v1", "https://model-api.example.test:8443/v1"]) {
			await expectGeoError(
				updateSamplingTarget(admin, target.id, input({ baseUrl, model: "test-model" })),
				"VALIDATION_ERROR",
			);
		}
	});

	it("does not treat a reordered config as a new source", async () => {
		const target = await modelApiTarget(true);
		const updated = await updateSamplingTarget(
			admin,
			target.id,
			input({ model: "test-model", baseUrl: "https://model-api.example.test/v1" }),
		);
		expect(updated.verificationStatus).toBe("PASSED");
	});

	it("keeps the credential when the host stays the same", async () => {
		const target = await modelApiTarget(true);
		await setSamplingTargetCredential(admin, target.id, "sk-test-0123456789");
		const updated = await updateSamplingTarget(
			admin,
			target.id,
			input({ baseUrl: "https://model-api.example.test/v2", model: "test-model" }),
		);
		expect(updated.credentialRef).not.toBeNull();
		expect(updated.verificationStatus).toBe("UNVERIFIED");
	});

	it("removes the credential when the endpoint moves, so a connectivity check cannot carry it to the new host", async () => {
		const target = await modelApiTarget(true);
		await setSamplingTargetCredential(admin, target.id, "sk-test-0123456789");
		const updated = await updateSamplingTarget(
			admin,
			target.id,
			input({ baseUrl: "https://elsewhere.example.test/v1", model: "test-model" }),
		);
		expect(updated).toMatchObject({ credentialRef: null, verificationStatus: "UNVERIFIED" });
		const stored = await db.select().from(secrets).where(eq(secrets.name, `geo-target:${target.id}`));
		expect(stored).toEqual([]);

		const sent: (string | null)[] = [];
		const result = await checkSamplingTargetConnectivity(admin, target.id, {
			resolve: publicAddress,
			fetch: async (_url, init) => {
				sent.push(new Headers(init?.headers).get("authorization"));
				return Response.json({ data: [] });
			},
		});
		expect(result.available).toBe(false);
		expect(sent).toEqual([]);
		expect((await loadTarget(admin, target.id)).credentialRef).toBeNull();
	});

	it("refuses to check an endpoint that resolves to a private address, before reading its credential", async () => {
		const target = await modelApiTarget(true);
		await setSamplingTargetCredential(admin, target.id, "sk-test-0123456789");
		let called = false;
		const result = await checkSamplingTargetConnectivity(admin, target.id, {
			resolve: async () => [{ address: "10.0.0.8", family: 4 }],
			fetch: async () => {
				called = true;
				return Response.json({});
			},
		});
		expect(result.available).toBe(false);
		expect(result.detail).toContain("非公网");
		expect(called).toBe(false);
	});

	it("sends the credential to an endpoint that passes the check", async () => {
		const target = await modelApiTarget(true);
		await setSamplingTargetCredential(admin, target.id, "sk-test-0123456789");
		const sent: (string | null)[] = [];
		const result = await checkSamplingTargetConnectivity(admin, target.id, {
			resolve: publicAddress,
			fetch: async (_url, init) => {
				sent.push(new Headers(init?.headers).get("authorization"));
				return Response.json({ data: [{ id: "test-model" }] });
			},
		});
		expect(result.available).toBe(true);
		expect(sent).toEqual(["Bearer sk-test-0123456789"]);
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

describe("evidence files of a manual import", () => {
	const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
	let sequence = 0;
	const row = (evidenceLocation: string) => ({
		sampledAt: "2026-10-29T08:00:00Z",
		platform: "qwen",
		question: "高低压开关柜哪家好？",
		responseText: `示例电气较常见。#${++sequence}`,
		evidenceLocation,
	});
	const importing = (evidenceLocation: string) =>
		importManualObservations(operator, {
			format: "rows",
			promptSetId: frozenSetId,
			rows: [row(evidenceLocation)],
		});
	const upload = (bytes = PNG) => uploadEvidenceFile(operator, new File([bytes], "shot.png"));

	beforeAll(async () => {
		await createSamplingTarget(admin, {
			platform: "qwen",
			surfaceMode: "MANUAL_EVIDENCE",
			provider: "manual",
			language: "zh-CN",
			config: {},
			maxConcurrency: 1,
			enabled: true,
		});
	});

	it("refuses a note that points at another object in this organization's store", async () => {
		const store = getObjectStore();
		const knowledge = `geo/${organizationId}/knowledge/${"a".repeat(64)}.pdf`;
		await store.put(knowledge, "原件");
		for (const location of [knowledge, `geo/${organizationId}/reports/r1/report.pdf`]) {
			expect(await importing(location)).toMatchObject({ ok: false, code: "VALIDATION_ERROR" });
		}
		expect(await store.head(knowledge)).not.toBeNull();
	});

	it("serves the upload of its own import, once bound to that import", async () => {
		const file = await upload(new Uint8Array([...PNG, 9]));
		const result = await importing(file.ref);
		if (!result.ok) throw new Error(result.message);
		expect(result.created).toBe(1);
		const [observationId] = result.observationIds;
		const detail = await getObservation(operator, observationId as string);
		expect(detail.evidence.kind).toBe("object");
		const object = await readObservationEvidence(operator, observationId as string);
		expect(object.name).toBe(file.ref.slice("upload:".length));
		const [record] = await db
			.select()
			.from(geoEvidenceUploads)
			.where(and(eq(geoEvidenceUploads.organizationId, organizationId), eq(geoEvidenceUploads.sha256, file.sha256)));
		expect(record?.importBatchId).toBe(result.importBatchId);
	});

	it("does not let an upload be reused by a later import, or by someone who did not upload it", async () => {
		const file = await upload(new Uint8Array([...PNG, 10]));
		expect(await importing(file.ref)).toMatchObject({ ok: true, created: 1 });
		const reused = await importing(file.ref);
		expect(reused).toMatchObject({ ok: false, code: "EVIDENCE_REQUIRED" });

		const other = await upload(new Uint8Array([...PNG, 11]));
		const someoneElse = await importManualObservations(admin, {
			format: "rows",
			promptSetId: frozenSetId,
			rows: [row(other.ref)],
		});
		expect(someoneElse).toMatchObject({ ok: false, code: "EVIDENCE_REQUIRED" });
		expect(await importing(other.ref)).toMatchObject({ ok: true, created: 1 });
	});

	it("still skips an identical file sent again, though its upload is already used", async () => {
		const file = await upload(new Uint8Array([...PNG, 12]));
		const input = { format: "rows" as const, promptSetId: frozenSetId, rows: [row(file.ref)] };
		expect(await importManualObservations(operator, input)).toMatchObject({ ok: true, created: 1 });
		expect(await importManualObservations(operator, input)).toMatchObject({ ok: true, created: 0, skipped: 1 });
	});

	it("reads a stored pointer at someone else's object as text, and will not download it", async () => {
		const store = getObjectStore();
		const knowledge = `geo/${organizationId}/knowledge/${"b".repeat(64)}.pdf`;
		await store.put(knowledge, "原件");
		const target = await modelApiTarget(true);
		// An import from before uploads were recorded could still hold such a pointer.
		const [{ id: observationId }] = await db
			.insert(geoObservations)
			.values({
				organizationId,
				promptId: promptIds[0] as string,
				promptRevision: 1,
				questionText: "高低压开关柜哪家好？",
				targetId: target.id,
				platform: "deepseek",
				surfaceMode: "MANUAL_EVIDENCE",
				status: "VALID",
				responseText: "示例电气较常见。",
				sampledAt: new Date("2026-10-28T08:00:00Z"),
				importBatchId: randomUUID(),
				evidenceUri: knowledge,
			})
			.returning({ id: geoObservations.id });
		const detail = await getObservation(operator, observationId);
		expect(detail.evidence.kind).toBe("note");
		await expectGeoError(readObservationEvidence(operator, observationId), "NOT_FOUND");
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
		expect(total).toBe(4);
		expect(await promptStatusCounts(operator)).toMatchObject({ FROZEN: 4, DRAFT: 1 });
		expect((await promptRoleCoverage(operator)).length).toBeGreaterThan(0);
	});

	it("takes its own export straight back, counting reviewed rows as unchanged, plus new rows added to it", async () => {
		const exported = (await exportPromptsCsv(operator, {})).replace(/\r\n$/, "");
		const before = await promptStatusCounts(operator);
		const header = exported.replace(/^\uFEFF/, "").split("\r\n")[0] as string;
		const added = header
			.split(",")
			.map((column) => (column === "question" ? "配电柜厂家交期多久" : ""))
			.join(",");
		const result = await importPromptsCsv(operator, `${exported}\r\n${added}\r\n`);
		expect(result).toMatchObject({ created: 1, updated: 0, errors: [] });
		expect(result.unchanged).toBeGreaterThanOrEqual(before.FROZEN);
		expect((await promptStatusCounts(operator)).FROZEN).toBe(before.FROZEN);
	});

	it("still refuses a reviewed row that was edited in the file", async () => {
		const exported = await exportPromptsCsv(operator, {});
		const edited = exported.replace("高低压开关柜哪家好？", "高低压开关柜哪家强？");
		const result = await importPromptsCsv(operator, edited);
		expect(result.created).toBe(0);
		expect(result.errors.map((error) => error.column)).toContain("prompt_id");
	});
});
