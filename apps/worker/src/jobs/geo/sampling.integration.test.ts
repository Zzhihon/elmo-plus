import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { credentialRefFor, type FetchLike, targetSecretName } from "@workspace/geo-cn-providers";
import { GEO_EVALUATE_OBSERVATION_QUEUE, GEO_QUEUE, samplingRunIdempotencyKey } from "@workspace/geo-domain";
import { getObjectStore } from "@workspace/geo-evidence";
import { applyGeoBootstrapSites } from "@workspace/geo-site-ingestion/store";
import { db } from "@workspace/lib/db/db";
import type { DbConnection } from "@workspace/lib/db/db-connection";
import {
	geoBrandEntities,
	geoBuyerRoles,
	geoDictionaryVersions,
	geoEvaluations,
	geoGeneratedReports,
	geoObservationCitations,
	geoObservations,
	geoOptimizationTasks,
	geoPromptSetItems,
	geoPromptSets,
	geoPrompts,
	geoSamplingAttempts,
	geoSamplingBatches,
	geoSamplingRuns,
	geoSamplingTargets,
	geoSiteSources,
	organization,
	secrets,
} from "@workspace/lib/db/schema";
import { runGeoBootstrap } from "@workspace/lib/geo/bootstrap";
import { linkGeoRetestBatches } from "@workspace/lib/geo/maintenance";
import { encryptSecret, getKeyring } from "@workspace/lib/secrets";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { evaluateObservation, sweepUnevaluated } from "./evaluation-run";
import { generateReport, reportTick } from "./reports-generate";
import { applyGeoBootstrapTargets } from "./sampling-bootstrap";
import { processCaptureJob } from "./sampling-capture";
import { dispatchBatch, sweepSampling } from "./sampling-dispatch";
import { recountBatch } from "./sampling-store";

const sent = vi.hoisted(() => {
	process.env.ELMO_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
	return [] as { queue: string; data: Record<string, unknown> }[];
});

vi.mock("../../boss", () => ({
	getBoss: () => ({
		send: async (queue: string, data: Record<string, unknown>) => {
			sent.push({ queue, data });
			return randomUUID();
		},
		insert: async (queue: string, jobs: { data: Record<string, unknown> }[]) => {
			for (const job of jobs) sent.push({ queue, data: job.data });
		},
	}),
}));

const API_HOST = "https://model-api.example.test";
const ANSWER =
	"选购高低压开关柜可以参考以下品牌：\n1. 示例电气：额定电压 12kV，交付稳定，值得推荐。\n2. 样板开关：价格较低。";

type Mode = "answer" | "rate-limited" | "captcha" | "gateway-timeout" | "flaky";

let server: Server;
let baseUrl: string;
let objectRoot: string;
const modes = new Map<string, Mode>();
const calls = new Map<string, number>();

function startFakeModelApi(): Promise<void> {
	server = createServer((request, response) => {
		let body = "";
		request.on("data", (chunk) => {
			body += chunk;
		});
		request.on("end", () => {
			const { model } = JSON.parse(body) as { model: string };
			const count = (calls.get(model) ?? 0) + 1;
			calls.set(model, count);
			const mode = modes.get(model);
			const json = (status: number, payload: unknown, headers: Record<string, string> = {}) => {
				response.writeHead(status, { "content-type": "application/json", ...headers });
				response.end(JSON.stringify(payload));
			};
			if (mode === "rate-limited") return json(429, { error: { code: "rate_limit" } }, { "retry-after": "1" });
			if (mode === "gateway-timeout") return json(504, { error: { code: "timeout" } });
			if (mode === "captcha") {
				response.writeHead(200, { "content-type": "text/html" });
				return response.end("<html><body>请完成安全验证后继续</body></html>");
			}
			if (mode === "flaky" && count === 1) return json(503, { error: { code: "overloaded" } });
			return json(
				200,
				{
					id: `chatcmpl-${count}`,
					model: `${model}-2026`,
					choices: [{ message: { content: ANSWER }, finish_reason: "stop" }],
					usage: { prompt_tokens: 100, completion_tokens: 200 },
					citations: [{ url: "https://www.example-electric.test/products/kyn28?utm_source=x", title: "产品" }],
				},
				{ "x-request-id": `trace-${count}` },
			);
		});
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
			resolve();
		});
	});
}

/** Stands in for the provider's public host; the request itself is unchanged. */
const fakeFetch: FetchLike = (url, init) => fetch(String(url).replace(API_HOST, baseUrl), init);
/** Past any backoff, so a retried run is due straight away. */
const later = () => new Date(Date.now() + 30 * 60_000);

beforeAll(async () => {
	objectRoot = await mkdtemp(path.join(tmpdir(), "geo-objects-"));
	process.env.GEO_OBJECT_STORE_URL = `file://${objectRoot}`;
	await startFakeModelApi();
});

afterAll(async () => {
	await new Promise((resolve) => server.close(resolve));
	await rm(objectRoot, { recursive: true, force: true });
});

async function createOrganization(): Promise<string> {
	const id = `org-${randomUUID()}`;
	await db.insert(organization).values({ id, name: "示例电气", slug: id, createdAt: new Date() });
	return id;
}

const bootstrapFile = (organizationId: string) => ({
	organization: { id: organizationId },
	roles: [{ code: "procurement", title: "采购负责人", priority: 1 }],
	brands: [
		{ kind: "OWN", displayName: "示例电气", aliases: ["示例"], domains: ["www.example-electric.test"] },
		{ kind: "COMPETITOR", displayName: "样板开关" },
	],
	prompts: [
		{
			question: "高低压开关柜哪家好？",
			buyerRoleCode: "procurement",
			intent: "选型",
			productLine: "开关柜",
			geoRegion: "华东",
		},
		{
			question: "10kV 环网柜推荐品牌",
			buyerRoleCode: "procurement",
			intent: "选型",
			productLine: "环网柜",
			geoRegion: "华东",
		},
	],
	sites: [
		{
			baseUrl: "https://www.example-electric.test/",
			allowedHosts: ["www.example-electric.test"],
			profile: { id: "example-electric", version: 1, categories: [] },
		},
	],
	targets: [
		{
			key: "deepseek-api",
			platform: "deepseek",
			surfaceMode: "MODEL_API",
			provider: "deepseek",
			modelId: "answer",
			config: { baseUrl: `${API_HOST}/v1`, model: "answer" },
			enabled: true,
		},
	],
});

describe("bootstrap file", () => {
	it("imports brands, roles, prompts, sites and targets once, however often it runs", async () => {
		const organizationId = await createOrganization();
		const dir = await mkdtemp(path.join(tmpdir(), "geo-bootstrap-"));
		const file = path.join(dir, "bootstrap.json");
		await writeFile(file, JSON.stringify(bootstrapFile(organizationId)));
		const appliers = { sites: applyGeoBootstrapSites, targets: applyGeoBootstrapTargets };
		try {
			const first = await runGeoBootstrap(db, { path: file, appliers });
			expect(first?.sections).toMatchObject({
				roles: { created: 1 },
				brands: { created: 2, skipped: 0 },
				prompts: { created: 2, skipped: 0 },
				sites: { created: 1 },
				targets: { created: 1, skipped: 0 },
			});
			const second = await runGeoBootstrap(db, { path: file, appliers });
			expect(second?.sections).toMatchObject({
				roles: { created: 0 },
				brands: { created: 0, skipped: 2 },
				prompts: { created: 0, skipped: 2 },
				sites: { created: 0, unchanged: 1 },
				targets: { created: 0, skipped: 1 },
			});
		} finally {
			await rm(dir, { recursive: true, force: true });
		}

		const count = async (table: typeof geoPrompts | typeof geoBrandEntities | typeof geoSiteSources) =>
			(await db.select().from(table).where(eq(table.organizationId, organizationId))).length;
		expect(await count(geoPrompts)).toBe(2);
		expect(await count(geoBrandEntities)).toBe(2);
		expect(await count(geoSiteSources)).toBe(1);
		const versions = await db
			.select()
			.from(geoDictionaryVersions)
			.where(eq(geoDictionaryVersions.organizationId, organizationId));
		expect(versions).toHaveLength(1);
		const prompts = await db.select().from(geoPrompts).where(eq(geoPrompts.organizationId, organizationId));
		expect(prompts.every((prompt) => prompt.status === "DRAFT")).toBe(true);
		const [target] = await db
			.select()
			.from(geoSamplingTargets)
			.where(eq(geoSamplingTargets.organizationId, organizationId));
		expect(target?.verificationStatus).toBe("UNVERIFIED");
	});

	it("does not keep resending answers that cannot be evaluated until a dictionary exists", async () => {
		const organizationId = await createOrganization();
		const [prompt] = await db
			.insert(geoPrompts)
			.values({ organizationId, question: "开关柜哪家好", createdBy: "user-op" })
			.returning();
		const [target] = await db
			.insert(geoSamplingTargets)
			.values({
				organizationId,
				platform: "doubao",
				surfaceMode: "MANUAL_EVIDENCE",
				provider: "manual",
				createdBy: "u",
			})
			.returning();
		const [observation] = await db
			.insert(geoObservations)
			.values({
				organizationId,
				promptId: prompt.id,
				promptRevision: 1,
				questionText: prompt.question,
				targetId: target.id,
				platform: "doubao",
				surfaceMode: "MANUAL_EVIDENCE",
				status: "VALID",
				responseText: "示例电气",
				sampledAt: new Date(Date.now() - 3_600_000),
				createdAt: new Date(Date.now() - 3_600_000),
			})
			.returning();
		sent.splice(0);
		await sweepUnevaluated();
		expect(sent.some((job) => job.data.observationId === observation.id)).toBe(false);
		sent.splice(0);
	});

	it("refuses a targets section that is wrong instead of reporting it imported", async () => {
		const organizationId = await createOrganization();
		await expect(
			applyGeoBootstrapTargets(db, organizationId, [
				{ key: "bad", platform: "deepseek", surfaceMode: "MODEL_API", provider: "x", config: { apiKey: "inline" } },
			]),
		).rejects.toThrow(/密钥/);
	});
});

describe("sampling a frozen set through a model API", () => {
	let organizationId: string;
	let batchId: string;
	const targetIds: Record<Mode, string> = {} as Record<Mode, string>;

	async function createTarget(mode: Mode): Promise<string> {
		const model = `${mode}-${randomUUID().slice(0, 8)}`;
		modes.set(model, mode);
		const [target] = await db
			.insert(geoSamplingTargets)
			.values({
				organizationId,
				platform: "deepseek",
				surfaceMode: "MODEL_API",
				provider: "deepseek",
				modelId: model,
				config: { baseUrl: `${API_HOST}/v1`, model, pricing: { inputPer1k: 0.01, outputPer1k: 0.02 } },
				enabled: true,
				verificationStatus: "PASSED",
				retryPolicy: { maxAttempts: 2, baseDelayMs: 1000, maxDelayMs: 1000 },
				createdBy: "user-admin",
			})
			.returning();
		const name = targetSecretName(target.id);
		const keyring = getKeyring();
		if (!keyring) throw new Error("test keyring missing");
		await db.insert(secrets).values({
			name,
			encryptedValue: await encryptSecret(`sk-test-${randomBytes(8).toString("hex")}`, {
				key: keyring.primary,
				aad: `secret:${name}`,
			}),
		});
		await db
			.update(geoSamplingTargets)
			.set({ credentialRef: credentialRefFor(name) })
			.where(eq(geoSamplingTargets.id, target.id));
		return target.id;
	}

	async function runsOf(batch: string) {
		return db.select().from(geoSamplingRuns).where(eq(geoSamplingRuns.batchId, batch));
	}

	/** Plays the capture queue: every job the code sends is processed until nothing is left. */
	async function drainCaptures(): Promise<void> {
		for (let round = 0; round < 20; round++) {
			const jobs = sent.filter((job) => job.queue === GEO_QUEUE.samplingCapture);
			if (jobs.length === 0) return;
			for (const job of jobs) sent.splice(sent.indexOf(job), 1);
			for (const job of jobs) {
				await processCaptureJob(job.data as { organizationId: string; runId: string }, {
					fetch: fakeFetch,
					now: later,
				});
			}
		}
		throw new Error("capture jobs kept coming");
	}

	beforeAll(async () => {
		organizationId = await createOrganization();
		await runGeoBootstrap(db, {
			path: await (async () => {
				const dir = await mkdtemp(path.join(tmpdir(), "geo-bootstrap-"));
				const file = path.join(dir, "bootstrap.json");
				const { targets: _targets, sites: _sites, ...rest } = bootstrapFile(organizationId);
				await writeFile(file, JSON.stringify(rest));
				return file;
			})(),
		});
		for (const mode of ["answer", "rate-limited", "captcha", "gateway-timeout", "flaky"] as Mode[]) {
			targetIds[mode] = await createTarget(mode);
		}

		const prompts = await db.select().from(geoPrompts).where(eq(geoPrompts.organizationId, organizationId));
		await db.update(geoPrompts).set({ status: "BASELINE" }).where(eq(geoPrompts.organizationId, organizationId));
		const [role] = await db.select().from(geoBuyerRoles).where(eq(geoBuyerRoles.organizationId, organizationId));
		const [set] = await db
			.insert(geoPromptSets)
			.values({ organizationId, name: "基线", createdBy: "user-op" })
			.returning();
		await db.insert(geoPromptSetItems).values(
			prompts.map((prompt) => ({
				organizationId,
				setId: set.id,
				promptId: prompt.id,
				promptRevision: prompt.currentRevision,
				questionText: prompt.question,
				labels: {
					buyerRoleId: role?.id ?? null,
					buyerRoleCode: role?.code ?? null,
					buyerRoleTitle: role?.title ?? null,
					intent: prompt.intent,
					productLine: prompt.productLine,
					geoRegion: prompt.geoRegion,
					priority: "P1" as const,
					language: "zh-CN",
					tier: "CORE" as const,
					ownerId: null,
				},
			})),
		);
		await db
			.update(geoPromptSets)
			.set({ status: "FROZEN", frozenAt: new Date(), frozenBy: "user-op" })
			.where(eq(geoPromptSets.id, set.id));

		// Planned exactly as createSamplingBatch plans it: one run per prompt × target × repeat.
		const [batch] = await db
			.insert(geoSamplingBatches)
			.values({
				organizationId,
				promptSetId: set.id,
				repeatCount: 1,
				plannedCount: prompts.length * 5,
				requestedBy: "user-op",
				idempotencyKey: randomUUID(),
			})
			.returning();
		batchId = batch.id;
		await db.insert(geoSamplingRuns).values(
			prompts.flatMap((prompt) =>
				Object.values(targetIds).map((targetId) => ({
					organizationId,
					batchId,
					promptId: prompt.id,
					targetId,
					repeatIndex: 0,
					idempotencyKey: samplingRunIdempotencyKey({ batchId, promptId: prompt.id, targetId, repeatIndex: 0 }),
				})),
			),
		);
	});

	it("captures every planned run, classifies each failure and stores evidence for each answer", async () => {
		expect(await dispatchBatch(organizationId, batchId)).toBe(10);
		await drainCaptures();

		const runs = await runsOf(batchId);
		const statusByTarget = (targetId: string) =>
			runs.filter((run) => run.targetId === targetId).map((run) => [run.status, run.attemptCount]);
		expect(statusByTarget(targetIds.answer)).toEqual([
			["VALID", 1],
			["VALID", 1],
		]);
		expect(statusByTarget(targetIds["rate-limited"])).toEqual([
			["RATE_LIMITED", 2],
			["RATE_LIMITED", 2],
		]);
		expect(statusByTarget(targetIds.captcha)).toEqual([
			["CAPTCHA", 1],
			["CAPTCHA", 1],
		]);
		expect(statusByTarget(targetIds["gateway-timeout"])).toEqual([
			["TIMEOUT", 2],
			["TIMEOUT", 2],
		]);
		expect(statusByTarget(targetIds.flaky).map(([status]) => status)).toEqual(["VALID", "VALID"]);

		const observations = await db
			.select()
			.from(geoObservations)
			.where(eq(geoObservations.organizationId, organizationId));
		expect(observations).toHaveLength(10);
		const valid = observations.filter((row) => row.status === "VALID");
		expect(valid).toHaveLength(4);
		for (const observation of valid) {
			expect(observation.responseText).toBe(ANSWER);
			expect(observation.responseMetadata).toMatchObject({ proxyEvaluation: true });
			const stored = JSON.parse(await readFile(path.join(objectRoot, observation.evidenceUri as string), "utf8"));
			expect(stored.response.choices[0].message.content).toBe(ANSWER);
		}
		for (const failed of observations.filter((row) => row.status !== "VALID")) {
			expect(failed.responseText).toBeNull();
			expect(failed.errorCode).toMatch(/RATE_LIMITED|CAPTCHA_REQUIRED|UPSTREAM_TIMEOUT/);
		}
		const citations = await db
			.select()
			.from(geoObservationCitations)
			.where(
				inArray(
					geoObservationCitations.observationId,
					valid.map((row) => row.id),
				),
			);
		expect(citations).toHaveLength(4);
		expect(citations[0]?.host).toBe("www.example-electric.test");

		const [batch] = await db.select().from(geoSamplingBatches).where(eq(geoSamplingBatches.id, batchId));
		expect(batch).toMatchObject({
			status: "PARTIAL",
			plannedCount: 10,
			validCount: 4,
			unavailableCount: 2,
			failedCount: 4,
		});
		expect(Number(batch?.costEstimate)).toBeGreaterThan(0);

		const evaluationJobs = sent.filter((job) => job.queue === GEO_EVALUATE_OBSERVATION_QUEUE);
		expect(evaluationJobs.map((job) => job.data.observationId).sort()).toEqual(valid.map((row) => row.id).sort());
	});

	it("does not sample or count a finished run again when its job or the batch is replayed", async () => {
		const before = await db
			.select()
			.from(geoSamplingAttempts)
			.where(eq(geoSamplingAttempts.organizationId, organizationId));
		const [run] = await runsOf(batchId);
		expect(await processCaptureJob({ organizationId, runId: run.id }, { fetch: fakeFetch, now: later })).toEqual({
			kind: "skipped",
			reason: run.status,
		});
		expect(await dispatchBatch(organizationId, batchId)).toBe(0);
		const after = await db
			.select()
			.from(geoSamplingAttempts)
			.where(eq(geoSamplingAttempts.organizationId, organizationId));
		expect(after).toHaveLength(before.length);
	});

	it("counts an explicit re-sample once, in place of the slot it repeats", async () => {
		const [timedOut] = (await runsOf(batchId)).filter((run) => run.targetId === targetIds["gateway-timeout"]);
		const model = [...modes.entries()].find(([, mode]) => mode === "gateway-timeout")?.[0] as string;
		modes.set(model, "answer");

		// As resampleRun writes it: a new run on the same slot pointing at the old one.
		const [resample] = await db
			.insert(geoSamplingRuns)
			.values({
				organizationId,
				batchId,
				promptId: timedOut.promptId,
				targetId: timedOut.targetId,
				repeatIndex: timedOut.repeatIndex,
				idempotencyKey: samplingRunIdempotencyKey({ ...timedOut, resampleOf: timedOut.id }),
				retryOfRunId: timedOut.id,
				retryRelation: "EXPLICIT_RESAMPLE",
			})
			.returning();
		sent.push({ queue: GEO_QUEUE.samplingCapture, data: { organizationId, runId: resample.id } });
		await drainCaptures();

		const [observation] = await db.select().from(geoObservations).where(eq(geoObservations.runId, resample.id));
		const [original] = await db.select().from(geoObservations).where(eq(geoObservations.runId, timedOut.id));
		expect(observation).toMatchObject({ status: "VALID", retryOfObservationId: original?.id });
		const [batch] = await db.select().from(geoSamplingBatches).where(eq(geoSamplingBatches.id, batchId));
		expect(batch).toMatchObject({ plannedCount: 10, validCount: 5, unavailableCount: 2, failedCount: 3 });
	});

	it("evaluates each stored answer once against the dictionary", async () => {
		const valid = await db
			.select()
			.from(geoObservations)
			.where(and(eq(geoObservations.organizationId, organizationId), eq(geoObservations.status, "VALID")));
		for (const observation of valid) {
			const outcome = await evaluateObservation(organizationId, observation.id);
			expect(outcome.evaluated).toBe(true);
			expect(await evaluateObservation(organizationId, observation.id)).toEqual({
				evaluated: false,
				reason: "already-evaluated",
			});
		}
		const failed = await db
			.select({ id: geoObservations.id })
			.from(geoObservations)
			.where(and(eq(geoObservations.organizationId, organizationId), eq(geoObservations.status, "CAPTCHA")));
		expect(await evaluateObservation(organizationId, failed[0]?.id as string)).toEqual({
			evaluated: false,
			reason: "not-evaluable",
		});

		const evaluations = await db.select().from(geoEvaluations).where(eq(geoEvaluations.organizationId, organizationId));
		expect(evaluations).toHaveLength(valid.length);
		for (const evaluation of evaluations) {
			expect(evaluation).toMatchObject({ brandMentioned: true, hasOrderedList: true, brandRank: 1, isCurrent: true });
			expect(evaluation.competitorHits).toEqual([
				expect.objectContaining({ name: "样板开关", mentioned: true, rank: 2 }),
			]);
			expect(evaluation.dictionaryVersionId).not.toBeNull();
		}
	});
	it("leaves nothing for the recovery sweeps once every run and answer is settled", async () => {
		sent.splice(0);
		const later = new Date(Date.now() + 60 * 60_000);
		await sweepSampling(later);
		await sweepUnevaluated();
		const queued = sent.splice(0);
		const ours = queued.filter((job) => job.data.organizationId === organizationId);
		expect(ours).toEqual([]);
	});

	it("creates the monthly report once per organization that sampled in the month", async () => {
		// Two hours and a minute after the month of these samples ends, China time.
		const sampledMonth = new Date(Date.now() + 8 * 3_600_000);
		const nextMonth = Date.UTC(sampledMonth.getUTCFullYear(), sampledMonth.getUTCMonth() + 1, 1) - 8 * 3_600_000;
		const tick = new Date(nextMonth + 2 * 3_600_000 + 60_000);
		const first = await reportTick(tick);
		expect(first.created).toBeGreaterThanOrEqual(1);
		const reports = await db
			.select()
			.from(geoGeneratedReports)
			.where(
				and(
					eq(geoGeneratedReports.organizationId, organizationId),
					eq(geoGeneratedReports.generatedBy, "system:monthly-report"),
				),
			);
		expect(reports).toHaveLength(1);
		expect((await reportTick(tick)).created).toBe(0);
		sent.splice(0);
	});

	describe("the report on those answers", () => {
		const LOCAL_CJK_FONTS = [
			"/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
			"/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc",
			"/System/Library/Fonts/STHeiti Medium.ttc#STHeitiSC-Medium",
		];
		const localFont = LOCAL_CJK_FONTS.find((candidate) => existsSync(candidate.split("#")[0] as string));

		async function queueReport() {
			const [batch] = await db.select().from(geoSamplingBatches).where(eq(geoSamplingBatches.id, batchId));
			const [report] = await db
				.insert(geoGeneratedReports)
				.values({
					organizationId,
					periodStart: new Date(Date.now() - 7 * 86_400_000),
					periodEnd: new Date(Date.now() + 3_600_000),
					metricVersion: "pending",
					filters: {
						kind: "ADHOC",
						periodLabel: "测试周期",
						promptSetId: batch?.promptSetId ?? null,
						notes: null,
						nextPlan: null,
					},
					title: "GEO 报告 · 测试周期",
					generatedBy: "user-op",
				})
				.returning();
			return report;
		}

		it("still stores the snapshot and CSV when no Chinese font is available, and says why there is no PDF", async () => {
			vi.stubEnv("GEO_PDF_FONT_PATH", path.join(objectRoot, "missing-font.ttc"));
			try {
				const report = await queueReport();
				expect(await generateReport(organizationId, report.id)).toEqual({
					status: "SUCCEEDED",
					reason: "pdf-unavailable",
				});
				const [row] = await db.select().from(geoGeneratedReports).where(eq(geoGeneratedReports.id, report.id));
				expect(row).toMatchObject({ status: "SUCCEEDED", pdfObjectKey: null });
				expect(row?.pdfUnavailableReason).toMatch(/GEO_PDF_FONT_PATH/);
				expect(row?.snapshot).not.toBeNull();
				const csv = await readFile(path.join(objectRoot, row?.csvObjectKey as string), "utf8");
				expect(csv).toContain("DeepSeek");
			} finally {
				vi.unstubAllEnvs();
			}
		});

		it("does not let a worker that lost its claim overwrite the report that replaced it", async () => {
			vi.stubEnv("GEO_PDF_FONT_PATH", path.join(objectRoot, "missing-font.ttc"));
			const store = getObjectStore();
			const put = store.put.bind(store);
			const report = await queueReport();
			const spy = vi.spyOn(store, "put").mockImplementationOnce(async (key, body, options) => {
				await db
					.update(geoGeneratedReports)
					.set({ status: "SUCCEEDED", reviewStatus: "APPROVED", claimToken: null })
					.where(eq(geoGeneratedReports.id, report.id));
				return put(key, body, options);
			});
			try {
				expect(await generateReport(organizationId, report.id)).toEqual({ status: "SKIPPED", reason: "claim-lost" });
				const [row] = await db.select().from(geoGeneratedReports).where(eq(geoGeneratedReports.id, report.id));
				expect(row).toMatchObject({
					status: "SUCCEEDED",
					reviewStatus: "APPROVED",
					csvObjectKey: null,
					snapshot: null,
				});
			} finally {
				spy.mockRestore();
				vi.unstubAllEnvs();
			}
		});

		it("does not rebuild a report still held by a live claim when its job is delivered again", async () => {
			const report = await queueReport();
			await db
				.update(geoGeneratedReports)
				.set({ status: "RUNNING", claimToken: "held-elsewhere" })
				.where(eq(geoGeneratedReports.id, report.id));
			expect(await generateReport(organizationId, report.id)).toEqual({ status: "SKIPPED", reason: "not-pending" });
		});

		it.runIf(localFont)("stores a snapshot, CSV and PDF built from the evaluated answers", async () => {
			vi.stubEnv("GEO_PDF_FONT_PATH", localFont as string);
			try {
				const report = await queueReport();
				expect(await generateReport(organizationId, report.id)).toEqual({ status: "SUCCEEDED" });
				expect(await generateReport(organizationId, report.id)).toEqual({ status: "SKIPPED", reason: "not-pending" });
				const [row] = await db.select().from(geoGeneratedReports).where(eq(geoGeneratedReports.id, report.id));
				expect(row?.status).toBe("SUCCEEDED");
				const snapshot = row?.snapshot as {
					insights: { totals: { valid: number; evaluated: number; planned: number } };
					evaluationRefs: unknown[];
				};
				expect(snapshot.insights.totals).toMatchObject({ planned: 10, valid: 5, evaluated: 5 });
				expect(snapshot.evaluationRefs).toHaveLength(5);
				const csv = await readFile(path.join(objectRoot, row?.csvObjectKey as string), "utf8");
				expect(csv.charCodeAt(0)).toBe(0xfeff);
				expect(csv).toContain("DeepSeek");
				const pdf = await readFile(path.join(objectRoot, row?.pdfObjectKey as string));
				expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
			} finally {
				vi.unstubAllEnvs();
			}
		});
	});
});

describe("batch status under concurrent completion", () => {
	let organizationId: string;
	let promptSetId: string;
	let targetId: string;

	beforeAll(async () => {
		organizationId = await createOrganization();
		const [target] = await db
			.insert(geoSamplingTargets)
			.values({
				organizationId,
				platform: "deepseek",
				surfaceMode: "MODEL_API",
				provider: "deepseek",
				modelId: "fixture",
				enabled: true,
				verificationStatus: "PASSED",
				createdBy: "user-admin",
			})
			.returning();
		targetId = target.id;
		const [set] = await db
			.insert(geoPromptSets)
			.values({ organizationId, name: "并发", status: "FROZEN", frozenAt: new Date(), createdBy: "user-op" })
			.returning();
		promptSetId = set.id;
	});

	async function planBatchOf(count: number, setId = promptSetId): Promise<{ batch: string; runs: string[] }> {
		const [prompt] = await db
			.insert(geoPrompts)
			.values({ organizationId, question: `高低压开关柜怎么选 ${randomUUID()}`, createdBy: "user-op" })
			.returning();
		const [batch] = await db
			.insert(geoSamplingBatches)
			.values({
				organizationId,
				promptSetId: setId,
				status: "RUNNING",
				repeatCount: count,
				plannedCount: count,
				requestedBy: "user-op",
				idempotencyKey: randomUUID(),
			})
			.returning();
		const runs = await db
			.insert(geoSamplingRuns)
			.values(
				Array.from({ length: count }, (_, repeatIndex) => ({
					organizationId,
					batchId: batch.id,
					promptId: prompt.id,
					targetId,
					repeatIndex,
					idempotencyKey: randomUUID(),
				})),
			)
			.returning({ id: geoSamplingRuns.id });
		return { batch: batch.id, runs: runs.map((run) => run.id) };
	}

	it("closes a batch whose last runs finish at the same moment, whichever commits first", async () => {
		const { batch, runs } = await planBatchOf(2);
		const [first = "", second = ""] = runs;
		const finish = (tx: DbConnection, runId: string) =>
			tx.update(geoSamplingRuns).set({ status: "VALID" }).where(eq(geoSamplingRuns.id, runId));

		let releaseFirst: () => void = () => {};
		const firstMayCommit = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		let firstCounted: () => void = () => {};
		const firstHasCounted = new Promise<void>((resolve) => {
			firstCounted = resolve;
		});
		const firstTx = db.transaction(async (tx) => {
			await finish(tx, first);
			await recountBatch(tx, batch);
			firstCounted();
			await firstMayCommit;
		});
		await firstHasCounted;
		const secondTx = db.transaction(async (tx) => {
			await finish(tx, second);
			await recountBatch(tx, batch);
		});
		await new Promise((resolve) => setTimeout(resolve, 100));
		releaseFirst();
		await Promise.all([firstTx, secondTx]);

		const [row] = await db.select().from(geoSamplingBatches).where(eq(geoSamplingBatches.id, batch));
		expect(row).toMatchObject({ status: "COMPLETED", validCount: 2 });
		expect(row?.finishedAt).not.toBeNull();
	});

	it("links such a batch to the work order waiting for its retest", async () => {
		const [set] = await db
			.insert(geoPromptSets)
			.values({ organizationId, name: "复测", status: "FROZEN", frozenAt: new Date(), createdBy: "user-op" })
			.returning();
		const baseline = await planBatchOf(1, set.id);
		const [task] = await db
			.insert(geoOptimizationTasks)
			.values({
				organizationId,
				title: "补充参数说明",
				kind: "FAQ",
				sourceKind: "OBSERVATION",
				state: "PENDING_RETEST",
				beforeBatchId: baseline.batch,
				publishedAt: new Date(Date.now() - 60_000),
				createdBy: "user-op",
			})
			.returning();
		const retest = await planBatchOf(2, set.id);
		await Promise.all(
			retest.runs.map((runId) =>
				db.transaction(async (tx) => {
					await tx.update(geoSamplingRuns).set({ status: "VALID" }).where(eq(geoSamplingRuns.id, runId));
					await recountBatch(tx, retest.batch);
				}),
			),
		);
		await linkGeoRetestBatches(db, new Date());
		const [linked] = await db.select().from(geoOptimizationTasks).where(eq(geoOptimizationTasks.id, task.id));
		expect(linked?.afterBatchId).toBe(retest.batch);
	});

	it("settles a batch left marked running with no run still to finish", async () => {
		const { batch, runs } = await planBatchOf(1);
		await db
			.update(geoSamplingRuns)
			.set({ status: "VALID" })
			.where(eq(geoSamplingRuns.id, runs[0] ?? ""));
		const later = new Date(Date.now() + 3_600_000);
		await sweepSampling(later);
		const [row] = await db.select().from(geoSamplingBatches).where(eq(geoSamplingBatches.id, batch));
		expect(row).toMatchObject({ status: "COMPLETED", validCount: 1 });
	});
});
