import { randomUUID } from "node:crypto";
import {
	BROWSER_AGENT_SOURCE_METHOD_VERSION,
	BROWSER_IMPORT_MAX_ROWS,
	type BrowserImportRow,
	type BrowserRowError,
	browserPlanKey,
	browserPlanWindow,
	parseBrowserAgentConfig,
	validateBrowserRows,
} from "@workspace/geo-cn-providers";
import {
	assertGeoPermission,
	GEO_CATALOG_SET_NAME,
	GEO_EVALUATE_OBSERVATION_QUEUE,
	GEO_PLATFORM_LABELS,
	GeoError,
	type GeoPlatform,
	type GeoPrincipal,
	isEvaluableObservation,
} from "@workspace/geo-domain";
import { geoObjectKey, getObjectStore, hostOf, normalizeUrl } from "@workspace/geo-evidence";
import { db } from "@workspace/lib/db/db";
import type { DbConnection } from "@workspace/lib/db/db-connection";
import {
	geoEvidenceUploads,
	geoObservationCitations,
	geoObservations,
	geoPromptSetItems,
	geoPromptSets,
	geoSamplingTargets,
	organization,
} from "@workspace/lib/db/schema";
import { writeGeoAudit } from "@workspace/lib/geo/audit";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { enqueueGeoJob } from "@/lib/geo/enqueue";
import { EVIDENCE_MAX_BYTES, sniffEvidenceType, uploadEvidenceFile } from "./observations-import-core";

type TargetRow = typeof geoSamplingTargets.$inferSelect;

interface PlanTarget {
	target: TargetRow;
	chatUrl: string;
	notes: string | null;
	repeats: number;
}

const BROWSER_RULES = [
	"只在用户本人已登录的浏览器中操作，不新建账号、不绕过验证码或登录",
	"每个问题新开一个对话，逐字输入 question 原文，不加任何前缀或解释",
	"等回答完全生成后再记录，回答原文和引用链接都要完整复制",
	"每条有回答的记录至少上传一张能看到问题和回答的截图",
	"遇到验证码、需要登录、限流或页面改版时停下该条，按 FAILED 记录失败原因，不要硬试",
	"不在 AI 应用里点赞、反馈或分享，不改动账号设置",
	"completedRunKeys 中已有的 runKey 不再重复提问",
];

/** The customer's own monitoring questions when they exist, as the sampling dialog picks them. */
async function planPromptSet(organizationId: string) {
	const sets = await db
		.select({ id: geoPromptSets.id, name: geoPromptSets.name, version: geoPromptSets.version })
		.from(geoPromptSets)
		.where(and(eq(geoPromptSets.organizationId, organizationId), eq(geoPromptSets.status, "FROZEN")))
		.orderBy(desc(geoPromptSets.frozenAt));
	const set = sets.find((item) => item.name === GEO_CATALOG_SET_NAME) ?? sets[0];
	if (!set) throw new GeoError("VALIDATION_ERROR", "还没有冻结的问法集，请先在问法页冻结一套监测问题");
	const items = await db
		.select({
			promptId: geoPromptSetItems.promptId,
			revision: geoPromptSetItems.promptRevision,
			text: geoPromptSetItems.questionText,
			labels: geoPromptSetItems.labels,
		})
		.from(geoPromptSetItems)
		.where(and(eq(geoPromptSetItems.setId, set.id), eq(geoPromptSetItems.organizationId, organizationId)))
		.orderBy(asc(geoPromptSetItems.createdAt));
	const core = items.filter((item) => item.labels.tier === "CORE");
	return { set, items: core.length > 0 ? core : items };
}

/** One enabled, correctly configured browser-agent target per platform, the oldest if there are several. */
async function planTargets(organizationId: string): Promise<Map<GeoPlatform, PlanTarget>> {
	const rows = await db
		.select()
		.from(geoSamplingTargets)
		.where(
			and(
				eq(geoSamplingTargets.organizationId, organizationId),
				eq(geoSamplingTargets.surfaceMode, "BROWSER_AGENT"),
				eq(geoSamplingTargets.enabled, true),
			),
		)
		.orderBy(asc(geoSamplingTargets.createdAt));
	const targets = new Map<GeoPlatform, PlanTarget>();
	for (const target of rows) {
		const config = parseBrowserAgentConfig(target.config);
		if (!config.ok || targets.has(target.platform)) continue;
		targets.set(target.platform, {
			target,
			chatUrl: config.value.chatUrl,
			notes: config.value.notes ?? null,
			repeats: config.value.repeats,
		});
	}
	return targets;
}

function resolvePlanKey(planKey: string | undefined, now: Date) {
	const key = planKey ?? browserPlanKey(now);
	const window = browserPlanWindow(key);
	if (!window) throw new GeoError("VALIDATION_ERROR", "planKey 应为 ISO 周，例如 2026-W45");
	return { key, window };
}

async function importedRunKeys(organizationId: string, planKey: string) {
	const o = geoObservations;
	const rows = await db
		.select({ runKey: sql<string>`${o.responseMetadata}->>'runKey'`, status: o.status })
		.from(o)
		.where(
			and(
				eq(o.organizationId, organizationId),
				eq(o.surfaceMode, "BROWSER_AGENT"),
				sql`${o.responseMetadata}->>'planKey' = ${planKey}`,
			),
		);
	const answered = new Set(rows.filter((row) => isEvaluableObservation(row.status)).map((row) => row.runKey));
	const failed = new Set(rows.map((row) => row.runKey).filter((key) => !answered.has(key)));
	return { completed: [...answered].sort(), failed: [...failed].sort() };
}

export const browserPlanInputSchema = z.object({
	planKey: z
		.string()
		.regex(/^\d{4}-W\d{2}$/, "planKey 应为 ISO 周，例如 2026-W45")
		.optional(),
});

/** What the browser agent should ask this week, on which apps, and what is already in. */
export async function getBrowserSamplingPlan(
	principal: GeoPrincipal,
	input: z.input<typeof browserPlanInputSchema> = {},
	now = new Date(),
) {
	assertGeoPermission(principal, "prompt.read");
	assertGeoPermission(principal, "target.read");
	const plan = resolvePlanKey(browserPlanInputSchema.parse(input).planKey, now);
	const [[org], promptSet, targets, runKeys] = await Promise.all([
		db
			.select({ id: organization.id, name: organization.name })
			.from(organization)
			.where(eq(organization.id, principal.organizationId)),
		planPromptSet(principal.organizationId),
		planTargets(principal.organizationId),
		importedRunKeys(principal.organizationId, plan.key),
	]);
	const repeats = Math.max(1, ...[...targets.values()].map((item) => item.repeats));
	return {
		planKey: plan.key,
		window: { from: plan.window.from.toISOString(), to: plan.window.to.toISOString() },
		organization: { id: org?.id ?? principal.organizationId, name: org?.name ?? null },
		promptSet: { id: promptSet.set.id, name: promptSet.set.name, version: promptSet.set.version },
		questions: promptSet.items.map((item) => ({
			promptId: item.promptId,
			text: item.text,
			buyerRole: item.labels.buyerRoleTitle ?? null,
		})),
		platforms: [...targets.entries()].map(([platform, item]) => ({
			platform,
			label: GEO_PLATFORM_LABELS[platform],
			targetId: item.target.id,
			chatUrl: item.chatUrl,
			notes: item.notes,
			repeats: item.repeats,
		})),
		repeats,
		runKeyFormat: `${plan.key}/<platform>/<promptId>/<repeat>`,
		completedRunKeys: runKeys.completed,
		failedRunKeys: runKeys.failed,
		rules: BROWSER_RULES,
	};
}

export const browserImportInputSchema = z.object({
	planKey: z.string().regex(/^\d{4}-W\d{2}$/, "planKey 应为 ISO 周，例如 2026-W45"),
	rows: z.array(z.unknown()).min(1).max(BROWSER_IMPORT_MAX_ROWS),
});

export interface BrowserImportResult {
	importBatchId: string | null;
	created: number;
	skipped: number;
	failedRecorded: number;
	errors: BrowserRowError[];
}

interface PreparedRow {
	row: BrowserImportRow;
	target: TargetRow;
	revision: number;
	evidenceKeys: string[];
}

async function evidenceKeys(organizationId: string, row: BrowserImportRow): Promise<string[] | BrowserRowError> {
	const store = getObjectStore();
	const keys: string[] = [];
	for (const ref of row.evidenceRefs) {
		const key = geoObjectKey(organizationId, "evidence", ref.slice("upload:".length));
		if (!(await store.head(key)))
			return { runKey: row.runKey, field: "evidenceRefs", message: `证据文件 ${ref} 尚未上传` };
		keys.push(key);
	}
	return keys;
}

function observationValues(principal: GeoPrincipal, item: PreparedRow, planKey: string, setId: string) {
	const { row } = item;
	const answered = row.status !== "FAILED";
	return {
		organizationId: principal.organizationId,
		promptId: row.promptId,
		promptSetId: setId,
		promptRevision: item.revision,
		questionText: row.question,
		targetId: item.target.id,
		platform: row.platform,
		surfaceMode: "BROWSER_AGENT" as const,
		status: answered ? row.status : row.observationStatus,
		responseText: answered ? row.responseText : null,
		sampledAt: row.sampledAt,
		responseMetadata: {
			runKey: row.runKey,
			planKey,
			repeatIndex: row.repeatIndex,
			session: row.session,
			evidenceKeys: item.evidenceKeys,
			note: row.note,
			proxyEvaluation: false,
			...(answered ? { droppedCitations: row.droppedCitations } : { failure: row.failure }),
		},
		providerVersion: "browser-agent",
		modelVersion: row.modelVersion,
		sourceMethodVersion: BROWSER_AGENT_SOURCE_METHOD_VERSION,
		evidenceUri: item.evidenceKeys[0] ?? null,
		errorCode: answered ? null : row.failure.code,
		importedBy: principal.actorId,
	};
}

/**
 * Each row stands on its own and its runKey makes sending it again harmless. A runKey
 * holds at most one answer: an answer is never replaced, and a failure only stays the
 * last word until a retry answers, which then supersedes it as one planned sample.
 */
export async function importBrowserObservations(
	principal: GeoPrincipal,
	raw: z.input<typeof browserImportInputSchema>,
	now = new Date(),
): Promise<BrowserImportResult> {
	assertGeoPermission(principal, "evidence.import");
	const { planKey, setId, prepared, errors } = await prepareRows(principal, browserImportInputSchema.parse(raw), now);
	if (prepared.length === 0) {
		return { importBatchId: null, created: 0, skipped: 0, failedRecorded: 0, errors };
	}

	const importBatchId = randomUUID();
	const outcome = await db.transaction(async (tx) => {
		await tx.execute(
			sql`select pg_advisory_xact_lock(hashtextextended(${`geo-browser-import:${principal.organizationId}`}, 0))`,
		);
		const prior = await priorAttempts(
			tx,
			principal.organizationId,
			prepared.map((item) => item.row.runKey),
		);
		const fresh = prepared.filter(
			(item) =>
				!prior.answered.has(item.row.runKey) &&
				!(item.row.status === "FAILED" && prior.lastFailure.has(item.row.runKey)),
		);
		const available = await unboundUploads(tx, principal, [...new Set(fresh.flatMap((item) => item.evidenceKeys))]);
		const rowErrors: BrowserRowError[] = [];
		const created: { id: string; evaluable: boolean }[] = [];
		const boundKeys = new Set<string>();
		for (const item of fresh) {
			if (item.evidenceKeys.some((key) => !available.has(key))) {
				rowErrors.push({
					runKey: item.row.runKey,
					field: "evidenceRefs",
					message: "证据文件不是由当前密钥的签发人为本次导入上传的，或已被其他导入使用，请重新上传",
				});
				continue;
			}
			created.push(
				await insertObservation(tx, principal, item, {
					...observationValues(principal, item, planKey, setId),
					retryOfObservationId: prior.lastFailure.get(item.row.runKey) ?? null,
					importBatchId,
				}),
			);
			for (const key of item.evidenceKeys) boundKeys.add(key);
		}
		await bindUploads(tx, principal, [...boundKeys], importBatchId);
		const summary = {
			created: created.filter((item) => item.evaluable).length,
			skipped: prepared.length - fresh.length,
			failedRecorded: created.filter((item) => !item.evaluable).length,
		};
		if (created.length > 0) {
			await writeGeoAudit(tx, {
				principal,
				action: "observation.import",
				entityType: "observation_import",
				entityId: importBatchId,
				metadata: { format: "browser-agent", planKey, promptSetId: setId, ...summary },
			});
		}
		return { created, rowErrors, summary };
	});

	await queueEvaluations(
		principal.organizationId,
		outcome.created.filter((item) => item.evaluable).map((item) => item.id),
	);
	return {
		importBatchId: outcome.created.length > 0 ? importBatchId : null,
		...outcome.summary,
		errors: [...errors, ...outcome.rowErrors],
	};
}

async function prepareRows(principal: GeoPrincipal, input: z.output<typeof browserImportInputSchema>, now: Date) {
	const plan = resolvePlanKey(input.planKey, now);
	const [promptSet, targets] = await Promise.all([
		planPromptSet(principal.organizationId),
		planTargets(principal.organizationId),
	]);
	const revisions = new Map(promptSet.items.map((item) => [item.promptId, item.revision]));
	const validated = validateBrowserRows(
		input.rows,
		{
			planKey: plan.key,
			window: plan.window,
			promptIds: new Set(revisions.keys()),
			repeatsByPlatform: new Map([...targets.entries()].map(([platform, item]) => [platform, item.repeats])),
		},
		now,
	);
	const errors = [...validated.errors];
	const prepared: PreparedRow[] = [];
	for (const row of validated.rows) {
		const keys = await evidenceKeys(principal.organizationId, row);
		if (!Array.isArray(keys)) errors.push(keys);
		else {
			const target = targets.get(row.platform)?.target as TargetRow;
			prepared.push({ row, target, revision: revisions.get(row.promptId) as number, evidenceKeys: keys });
		}
	}
	return { planKey: plan.key, setId: promptSet.set.id, prepared, errors };
}

async function priorAttempts(tx: DbConnection, organizationId: string, runKeys: string[]) {
	const o = geoObservations;
	const existing = await tx
		.select({ id: o.id, runKey: sql<string>`${o.responseMetadata}->>'runKey'`, status: o.status })
		.from(o)
		.where(and(eq(o.organizationId, organizationId), inArray(sql`${o.responseMetadata}->>'runKey'`, runKeys)))
		.orderBy(asc(o.createdAt));
	return {
		answered: new Set(existing.filter((row) => isEvaluableObservation(row.status)).map((row) => row.runKey)),
		lastFailure: new Map(
			existing.filter((row) => !isEvaluableObservation(row.status)).map((row) => [row.runKey, row.id]),
		),
	};
}

function uploadsOf(principal: GeoPrincipal, keys: string[]) {
	return and(
		eq(geoEvidenceUploads.organizationId, principal.organizationId),
		eq(geoEvidenceUploads.uploadedBy, principal.actorId),
		isNull(geoEvidenceUploads.importBatchId),
		inArray(geoEvidenceUploads.objectKey, keys),
	);
}

/** An answer may only point at files this caller uploaded and no import has used yet. */
async function unboundUploads(tx: DbConnection, principal: GeoPrincipal, keys: string[]): Promise<Set<string>> {
	if (keys.length === 0) return new Set();
	const rows = await tx
		.select({ key: geoEvidenceUploads.objectKey })
		.from(geoEvidenceUploads)
		.where(uploadsOf(principal, keys));
	return new Set(rows.map((row) => row.key));
}

async function bindUploads(tx: DbConnection, principal: GeoPrincipal, keys: string[], importBatchId: string) {
	if (keys.length === 0) return;
	await tx.update(geoEvidenceUploads).set({ importBatchId }).where(uploadsOf(principal, keys));
}

async function insertObservation(
	tx: DbConnection,
	principal: GeoPrincipal,
	item: PreparedRow,
	values: typeof geoObservations.$inferInsert,
): Promise<{ id: string; evaluable: boolean }> {
	const [observation] = await tx
		.insert(geoObservations)
		.values(values)
		.returning({ id: geoObservations.id, status: geoObservations.status });
	if (item.row.status !== "FAILED" && item.row.citations.length > 0) {
		await tx.insert(geoObservationCitations).values(
			item.row.citations.map((citation, ordinal) => ({
				organizationId: principal.organizationId,
				observationId: observation.id,
				ordinal,
				url: citation.url,
				normalizedUrl: normalizeUrl(citation.url),
				host: hostOf(citation.url),
				title: citation.title ?? null,
			})),
		);
	}
	return { id: observation.id, evaluable: isEvaluableObservation(observation.status) };
}

async function queueEvaluations(organizationId: string, observationIds: string[]) {
	for (const observationId of observationIds) {
		try {
			await enqueueGeoJob(
				GEO_EVALUATE_OBSERVATION_QUEUE,
				{ organizationId, observationId },
				{ singletonKey: `observation:${observationId}` },
			);
		} catch (error) {
			console.warn(
				`[geo-sampling] evaluation not queued for imported observation ${observationId}: ${error instanceof Error ? error.name : "error"}`,
			);
		}
	}
}

const BROWSER_EVIDENCE_TYPES = ["image/png", "image/jpeg", "application/pdf"] as const;

export const browserEvidenceInputSchema = z.object({
	fileName: z.string().trim().min(1).max(200),
	contentType: z.enum(BROWSER_EVIDENCE_TYPES),
	contentBase64: z
		.string()
		.min(1)
		.max(Math.ceil((EVIDENCE_MAX_BYTES * 4) / 3) + 4, "证据文件不能超过 10 MB"),
});

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** A screenshot sent inline by an agent, checked and stored exactly as an upload from the import page. */
export async function uploadBrowserEvidence(principal: GeoPrincipal, raw: z.input<typeof browserEvidenceInputSchema>) {
	assertGeoPermission(principal, "evidence.import");
	const input = browserEvidenceInputSchema.parse(raw);
	const encoded = input.contentBase64.replace(/^data:[^;,]+;base64,/, "").replace(/\s+/g, "");
	if (encoded.length % 4 !== 0 || !BASE64.test(encoded))
		throw new GeoError("VALIDATION_ERROR", "contentBase64 不是有效的 Base64");
	const bytes = Buffer.from(encoded, "base64");
	const type = sniffEvidenceType(bytes);
	if (!type || type.mime !== input.contentType) {
		throw new GeoError("VALIDATION_ERROR", "文件内容与 contentType 不符，只支持 PNG、JPEG 或 PDF");
	}
	const uploaded = await uploadEvidenceFile(principal, new File([bytes], input.fileName, { type: type.mime }));
	return { evidenceRef: uploaded.ref, sha256: uploaded.sha256, size: uploaded.size, contentType: uploaded.contentType };
}
