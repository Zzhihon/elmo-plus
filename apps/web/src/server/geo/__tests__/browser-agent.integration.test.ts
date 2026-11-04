import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { GEO_CATALOG_SET_NAME, type GeoPrincipal } from "@workspace/geo-domain";
import { computeCellMetrics } from "@workspace/geo-reports";
import { loadMetricData } from "@workspace/geo-reports/queries";
import { db } from "@workspace/lib/db/db";
import { geoObservations } from "@workspace/lib/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	getBrowserSamplingPlan,
	importBrowserObservations,
	uploadBrowserEvidence,
} from "@/server/geo/browser-agent-core";
import {
	createPrompt,
	createPromptSet,
	freezePromptSet,
	listBuyerRoles,
	transitionPrompt,
} from "@/server/geo/prompts-core";
import { createSamplingBatch } from "@/server/geo/sampling-core";
import {
	createSamplingTarget,
	listSamplingTargets,
	setSamplingTargetVerification,
} from "@/server/geo/sampling-targets-core";
import { createGeoOrganization, expectGeoError } from "@/test/integration/geo-fixtures";

const PLAN_KEY = "2026-W45";
const NOW = new Date("2026-11-06T12:00:00+08:00");
const SAMPLED_AT = "2026-11-05T10:00:00+08:00";

let organizationId: string;
let operator: GeoPrincipal;
let promptIds: string[];
let targetId: string;
let objectRoot: string;

beforeAll(async () => {
	objectRoot = await mkdtemp(path.join(tmpdir(), "geo-browser-"));
	vi.stubEnv("GEO_OBJECT_STORE_URL", `file://${objectRoot}`);
	const org = await createGeoOrganization();
	organizationId = org.organizationId;
	operator = await org.actor(["geo_operator"]);
	const admin = await org.actor(["platform_admin"]);
	const reviewer = await org.actor(["marketing_reviewer"]);
	const [role] = await listBuyerRoles(operator);
	promptIds = [];
	for (const question of ["高低压开关柜哪家好？", "环网柜厂家推荐"]) {
		const prompt = await createPrompt(operator, {
			question,
			buyerRoleId: role?.id,
			intent: "选型",
			productLine: "开关柜",
			geoRegion: "华东",
		});
		await transitionPrompt(operator, prompt.id, { action: "SUBMIT" });
		await transitionPrompt(reviewer, prompt.id, { action: "APPROVE" });
		promptIds.push(prompt.id);
	}
	const set = await createPromptSet(operator, { name: GEO_CATALOG_SET_NAME, promptIds });
	await freezePromptSet(operator, set.id);
	const target = await createSamplingTarget(admin, {
		platform: "doubao",
		surfaceMode: "BROWSER_AGENT",
		provider: "browser-agent",
		language: "zh-CN",
		config: { chatUrl: "https://chat.example-ai.test/" },
		maxConcurrency: 1,
		enabled: true,
	});
	await setSamplingTargetVerification(admin, target.id, { status: "PASSED", note: "已在用户浏览器中试跑" });
	targetId = target.id;
});

afterAll(async () => {
	await rm(objectRoot, { recursive: true, force: true });
});

async function screenshot(): Promise<string> {
	const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(64)]);
	const uploaded = await uploadBrowserEvidence(operator, {
		fileName: "answer.png",
		contentType: "image/png",
		contentBase64: png.toString("base64"),
	});
	return uploaded.evidenceRef;
}

function row(promptIndex: number, fields: Record<string, unknown>) {
	const promptId = promptIds[promptIndex];
	return {
		runKey: `${PLAN_KEY}/doubao/${promptId}/1`,
		planKey: PLAN_KEY,
		platform: "doubao",
		promptId,
		question: "高低压开关柜哪家好？",
		sampledAt: SAMPLED_AT,
		session: { account: "测试账号", loggedIn: true, webSearch: true },
		...fields,
	};
}

async function observationsOf(runKey: string) {
	return db
		.select()
		.from(geoObservations)
		.where(
			and(
				eq(geoObservations.organizationId, organizationId),
				sql`${geoObservations.responseMetadata}->>'runKey' = ${runKey}`,
			),
		);
}

async function doubaoCell() {
	const data = await loadMetricData(db, organizationId, {
		from: new Date("2026-11-02T00:00:00+08:00"),
		to: new Date("2026-11-09T00:00:00+08:00"),
		platform: "doubao",
		surfaceMode: "BROWSER_AGENT",
	});
	return computeCellMetrics({ platform: "doubao", surfaceMode: "BROWSER_AGENT", ...data });
}

describe("browser agent sampling", () => {
	it("is never offered to the automatic sampler, even enabled and verified", async () => {
		const [target] = (await listSamplingTargets(operator)).filter((item) => item.id === targetId);
		expect(target.runnable).toBe(false);
		await expectGeoError(
			createSamplingBatch(operator, { promptSetId: (await planSetId()) as string, targetIds: [targetId] }),
			"VALIDATION_ERROR",
		);
	});

	it("keeps a failed run out of every rate until a retry of the same runKey answers", async () => {
		const failed = row(0, { status: "FAILED", failure: { code: "CAPTCHA", message: "出现滑块验证" } });
		expect(await importBrowserObservations(operator, { planKey: PLAN_KEY, rows: [failed] }, NOW)).toMatchObject({
			created: 0,
			failedRecorded: 1,
			errors: [],
		});
		const [stored] = await observationsOf(failed.runKey);
		expect(stored.status).toBe("CAPTCHA");
		let cell = await doubaoCell();
		expect(cell.validSamples).toBe(0);
		expect(cell.mentionRate.status).toBe("NO_DATA");
		expect(cell.validSampleRate.breakdown).toMatchObject({ planned: 1, valid: 0 });

		const plan = await getBrowserSamplingPlan(operator, { planKey: PLAN_KEY }, NOW);
		expect(plan.completedRunKeys).not.toContain(failed.runKey);
		expect(plan.failedRunKeys).toContain(failed.runKey);

		const answer = row(0, { status: "VALID", responseText: "示例电气较常见。", evidenceRefs: [await screenshot()] });
		expect(await importBrowserObservations(operator, { planKey: PLAN_KEY, rows: [answer] }, NOW)).toMatchObject({
			created: 1,
			failedRecorded: 0,
		});
		cell = await doubaoCell();
		expect(cell.validSampleRate.breakdown).toMatchObject({ planned: 1, valid: 1 });
		expect((await getBrowserSamplingPlan(operator, { planKey: PLAN_KEY }, NOW)).completedRunKeys).toEqual([
			failed.runKey,
		]);
	});

	it("imports a runKey once however often it is sent", async () => {
		const answer = row(1, {
			question: "环网柜厂家推荐",
			status: "PARTIAL",
			responseText: "可以看看示例电气。",
			evidenceRefs: [await screenshot()],
		});
		const results = await Promise.all([
			importBrowserObservations(operator, { planKey: PLAN_KEY, rows: [answer] }, NOW),
			importBrowserObservations(operator, { planKey: PLAN_KEY, rows: [answer] }, NOW),
		]);
		expect(results.map((result) => result.created).sort()).toEqual([0, 1]);
		const late = await importBrowserObservations(
			operator,
			{ planKey: PLAN_KEY, rows: [{ ...answer, status: "FAILED", failure: { code: "TIMEOUT" } }] },
			NOW,
		);
		expect(late).toMatchObject({ created: 0, failedRecorded: 0, skipped: 1 });
		expect(await observationsOf(answer.runKey)).toHaveLength(1);
	});

	it("refuses an answer without a screenshot or for a question outside the plan, and says which runKey", async () => {
		const planKey = "2026-W44";
		const stray = "00000000-0000-4000-8000-000000000000";
		const earlier = (promptId: string, fields: Record<string, unknown>) => ({
			...row(0, fields),
			runKey: `${planKey}/doubao/${promptId}/1`,
			planKey,
			promptId,
			sampledAt: "2026-10-28T10:00:00+08:00",
		});
		const result = await importBrowserObservations(
			operator,
			{
				planKey,
				rows: [
					earlier(promptIds[0], { status: "VALID", responseText: "略" }),
					earlier(stray, { status: "VALID", responseText: "略", evidenceRefs: [await screenshot()] }),
				],
			},
			NOW,
		);
		expect(result.created).toBe(0);
		expect(result.errors.map((error) => [error.runKey.split("/")[2], error.field])).toEqual([
			[promptIds[0], "evidenceRefs"],
			[stray, "promptId"],
		]);
	});
});

async function planSetId() {
	return (await getBrowserSamplingPlan(operator, { planKey: PLAN_KEY }, NOW)).promptSet.id;
}
