import {
	createCaptureAdapter,
	enabledSamplingPlatforms,
	findSecretKeys,
	parseAvailableWindow,
	redactSecrets,
	validateTargetConfig,
} from "@workspace/geo-cn-providers";
import {
	assertGeoPermission,
	GEO_PLATFORMS,
	GEO_SURFACE_MODES,
	GEO_VERIFICATION_STATUSES,
	GeoError,
	type GeoPrincipal,
	targetCredentialRef,
} from "@workspace/geo-domain";
import { db } from "@workspace/lib/db/db";
import { geoSamplingAttempts, geoSamplingTargets } from "@workspace/lib/db/schema";
import { writeGeoAudit } from "@workspace/lib/geo/audit";
import { deleteGeoCredential, putGeoCredential } from "@workspace/lib/geo/credentials";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import { z } from "zod";
import { readTargetCredential, storedCredentialRefs } from "./sampling-credentials";
import { asJson, type JsonValue } from "./sampling-json";

export type SamplingTargetRow = typeof geoSamplingTargets.$inferSelect;

const RUNNABLE_VERIFICATION = new Set(["PASSED", "LIMITED"]);

export const targetInputSchema = z.object({
	platform: z.enum(GEO_PLATFORMS),
	surfaceMode: z.enum(GEO_SURFACE_MODES),
	provider: z.string().trim().min(1).max(100),
	modelId: z.string().trim().max(200).nullish(),
	region: z.string().trim().max(50).nullish(),
	language: z.string().trim().min(2).max(20).default("zh-CN"),
	config: z.record(z.string(), z.unknown()).default({}),
	availableWindow: z.unknown().nullish(),
	maxConcurrency: z.number().int().min(1).max(20).default(1),
	perMinuteQuota: z.number().int().min(1).max(10_000).nullish(),
	perDayQuota: z.number().int().min(1).max(1_000_000).nullish(),
	retryPolicy: z.record(z.string(), z.unknown()).nullish(),
	costBudget: z.number().min(0).max(1_000_000_000).nullish(),
	enabled: z.boolean().default(false),
});
export type TargetInput = z.infer<typeof targetInputSchema>;

export const verificationInputSchema = z.object({
	status: z.enum(GEO_VERIFICATION_STATUSES),
	note: z.string().trim().min(2, "请填写验证依据").max(2000),
});

export interface SamplingTargetStats {
	attempts7d: number;
	valid7d: number;
	p50Ms: number | null;
	p95Ms: number | null;
	cost30d: number;
}

export interface SamplingTargetView {
	id: string;
	platform: SamplingTargetRow["platform"];
	surfaceMode: SamplingTargetRow["surfaceMode"];
	provider: string;
	modelId: string | null;
	region: string | null;
	language: string;
	config: JsonValue;
	availableWindow: JsonValue;
	maxConcurrency: number;
	perMinuteQuota: number | null;
	perDayQuota: number | null;
	retryPolicy: JsonValue;
	costBudget: number | null;
	breakerState: SamplingTargetRow["breakerState"];
	breakerOpenedAt: string | null;
	verificationStatus: SamplingTargetRow["verificationStatus"];
	verificationNote: string | null;
	verifiedBy: string | null;
	verifiedAt: string | null;
	enabled: boolean;
	credentialConfigured: boolean;
	platformEnabled: boolean;
	configErrors: string[];
	/** Enabled, verified, configured and allowed by the deployment: a batch may include it. */
	runnable: boolean;
	stats: SamplingTargetStats;
	updatedAt: string;
}

function toView(
	row: SamplingTargetRow,
	stats: SamplingTargetStats | undefined,
	storedRefs: ReadonlySet<string>,
	platforms: ReadonlySet<string>,
): SamplingTargetView {
	const config = validateTargetConfig(row.surfaceMode, row.config, row.modelId);
	const platformEnabled = row.surfaceMode === "MANUAL_EVIDENCE" || platforms.has(row.platform);
	const configErrors = config.ok ? [] : config.errors;
	return {
		id: row.id,
		platform: row.platform,
		surfaceMode: row.surfaceMode,
		provider: row.provider,
		modelId: row.modelId,
		region: row.region,
		language: row.language,
		config: asJson(row.config),
		availableWindow: asJson(row.availableWindow),
		maxConcurrency: row.maxConcurrency,
		perMinuteQuota: row.perMinuteQuota,
		perDayQuota: row.perDayQuota,
		retryPolicy: asJson(row.retryPolicy),
		costBudget: row.costBudget === null ? null : Number(row.costBudget),
		breakerState: row.breakerState,
		breakerOpenedAt: row.breakerOpenedAt?.toISOString() ?? null,
		verificationStatus: row.verificationStatus,
		verificationNote: row.verificationNote,
		verifiedBy: row.verifiedBy,
		verifiedAt: row.verifiedAt?.toISOString() ?? null,
		enabled: row.enabled,
		credentialConfigured: row.credentialRef !== null && storedRefs.has(row.credentialRef),
		platformEnabled,
		configErrors,
		runnable:
			row.enabled &&
			row.surfaceMode !== "MANUAL_EVIDENCE" &&
			platformEnabled &&
			configErrors.length === 0 &&
			RUNNABLE_VERIFICATION.has(row.verificationStatus),
		stats: stats ?? { attempts7d: 0, valid7d: 0, p50Ms: null, p95Ms: null, cost30d: 0 },
		updatedAt: row.updatedAt.toISOString(),
	};
}

async function targetStats(organizationId: string): Promise<Map<string, SamplingTargetStats>> {
	const a = geoSamplingAttempts;
	const weekAgo = new Date(Date.now() - 7 * 86_400_000);
	const monthAgo = new Date(Date.now() - 30 * 86_400_000);
	const rows = await db
		.select({
			targetId: a.targetId,
			attempts7d: sql<number>`(count(*) filter (where ${a.startedAt} > ${weekAgo}))::int`,
			valid7d: sql<number>`(count(*) filter (where ${a.startedAt} > ${weekAgo} and ${a.status} = 'VALID'))::int`,
			p50Ms: sql<
				number | null
			>`percentile_cont(0.5) within group (order by ${a.durationMs}) filter (where ${a.startedAt} > ${weekAgo} and ${a.durationMs} is not null)`,
			p95Ms: sql<
				number | null
			>`percentile_cont(0.95) within group (order by ${a.durationMs}) filter (where ${a.startedAt} > ${weekAgo} and ${a.durationMs} is not null)`,
			cost30d: sql<string>`coalesce(sum(${a.costEstimate}), 0)`,
		})
		.from(a)
		.where(and(eq(a.organizationId, organizationId), gt(a.startedAt, monthAgo)))
		.groupBy(a.targetId);
	return new Map(
		rows.map((row) => [
			row.targetId,
			{
				attempts7d: row.attempts7d,
				valid7d: row.valid7d,
				p50Ms: row.p50Ms === null ? null : Math.round(Number(row.p50Ms)),
				p95Ms: row.p95Ms === null ? null : Math.round(Number(row.p95Ms)),
				cost30d: Number(row.cost30d),
			},
		]),
	);
}

/** The capability matrix: every target with its mode, verification and recent health. Never the credential. */
export async function listSamplingTargets(principal: GeoPrincipal): Promise<SamplingTargetView[]> {
	assertGeoPermission(principal, "target.read");
	const rows = await db
		.select()
		.from(geoSamplingTargets)
		.where(eq(geoSamplingTargets.organizationId, principal.organizationId))
		.orderBy(asc(geoSamplingTargets.platform), asc(geoSamplingTargets.surfaceMode), asc(geoSamplingTargets.createdAt));
	const [stats, stored] = await Promise.all([
		targetStats(principal.organizationId),
		storedCredentialRefs(principal.organizationId),
	]);
	const platforms = enabledSamplingPlatforms();
	return rows.map((row) => toView(row, stats.get(row.id), stored, platforms));
}

export async function loadTarget(principal: GeoPrincipal, targetId: string): Promise<SamplingTargetRow> {
	const [row] = await db
		.select()
		.from(geoSamplingTargets)
		.where(and(eq(geoSamplingTargets.id, targetId), eq(geoSamplingTargets.organizationId, principal.organizationId)));
	if (!row) throw new GeoError("NOT_FOUND", "采样目标不存在");
	return row;
}

function checkTargetInput(input: TargetInput): void {
	const secretKeys = findSecretKeys(input.config);
	if (secretKeys.length) {
		throw new GeoError("VALIDATION_ERROR", `配置中不能直接写入凭据（${secretKeys.join("、")}），请使用“设置凭据”`);
	}
	const window = parseAvailableWindow(input.availableWindow ?? null);
	if (!window.ok) throw new GeoError("VALIDATION_ERROR", `可用时间窗口无效：${window.error}`);
	if (input.enabled) {
		const config = validateTargetConfig(input.surfaceMode, input.config, input.modelId ?? null);
		if (!config.ok) throw new GeoError("VALIDATION_ERROR", `配置不完整，不能启用：${config.errors.join("；")}`);
	}
}

function targetValues(input: TargetInput) {
	const window = parseAvailableWindow(input.availableWindow ?? null);
	return {
		platform: input.platform,
		surfaceMode: input.surfaceMode,
		provider: input.provider,
		modelId: input.modelId || null,
		region: input.region || null,
		language: input.language,
		config: input.config,
		availableWindow: window.ok ? window.value : null,
		maxConcurrency: input.maxConcurrency,
		perMinuteQuota: input.perMinuteQuota ?? null,
		perDayQuota: input.perDayQuota ?? null,
		retryPolicy: input.retryPolicy ?? null,
		costBudget: input.costBudget === null || input.costBudget === undefined ? null : input.costBudget.toFixed(4),
		enabled: input.enabled,
	};
}

export async function createSamplingTarget(principal: GeoPrincipal, input: TargetInput): Promise<SamplingTargetRow> {
	assertGeoPermission(principal, "target.manage");
	checkTargetInput(input);
	return db.transaction(async (tx) => {
		const [row] = await tx
			.insert(geoSamplingTargets)
			.values({
				...targetValues(input),
				organizationId: principal.organizationId,
				createdBy: principal.actorId,
			})
			.returning();
		await writeGeoAudit(tx, {
			principal,
			action: "target.create",
			entityType: "sampling_target",
			entityId: row.id,
			after: row,
		});
		return row;
	});
}

const VERIFICATION_SENSITIVE = ["platform", "surfaceMode", "provider", "modelId", "config"] as const;

/** What was verified was a particular source; changing which source it is sends it back to UNVERIFIED. */
export async function updateSamplingTarget(
	principal: GeoPrincipal,
	targetId: string,
	input: TargetInput,
): Promise<SamplingTargetRow> {
	assertGeoPermission(principal, "target.manage");
	checkTargetInput(input);
	return db.transaction(async (tx) => {
		const [before] = await tx
			.select()
			.from(geoSamplingTargets)
			.where(and(eq(geoSamplingTargets.id, targetId), eq(geoSamplingTargets.organizationId, principal.organizationId)))
			.for("update");
		if (!before) throw new GeoError("NOT_FOUND", "采样目标不存在");
		const values = targetValues(input);
		const sourceChanged = VERIFICATION_SENSITIVE.some(
			(field) => JSON.stringify(before[field] ?? null) !== JSON.stringify(values[field] ?? null),
		);
		const [after] = await tx
			.update(geoSamplingTargets)
			.set({
				...values,
				...(sourceChanged && before.verificationStatus !== "UNVERIFIED"
					? {
							verificationStatus: "UNVERIFIED" as const,
							verificationNote: "数据源配置已变更，需重新验证",
							verifiedBy: null,
							verifiedAt: null,
						}
					: {}),
			})
			.where(eq(geoSamplingTargets.id, targetId))
			.returning();
		await writeGeoAudit(tx, {
			principal,
			action: "target.update",
			entityType: "sampling_target",
			entityId: targetId,
			before,
			after,
			metadata: { verificationReset: sourceChanged && before.verificationStatus !== "UNVERIFIED" },
		});
		return after;
	});
}

export async function setSamplingTargetEnabled(
	principal: GeoPrincipal,
	targetId: string,
	enabled: boolean,
): Promise<SamplingTargetRow> {
	assertGeoPermission(principal, "target.manage");
	return db.transaction(async (tx) => {
		const [before] = await tx
			.select()
			.from(geoSamplingTargets)
			.where(and(eq(geoSamplingTargets.id, targetId), eq(geoSamplingTargets.organizationId, principal.organizationId)))
			.for("update");
		if (!before) throw new GeoError("NOT_FOUND", "采样目标不存在");
		if (enabled) {
			const config = validateTargetConfig(before.surfaceMode, before.config, before.modelId);
			if (!config.ok) throw new GeoError("VALIDATION_ERROR", `配置不完整，不能启用：${config.errors.join("；")}`);
		}
		const [after] = await tx
			.update(geoSamplingTargets)
			.set({ enabled })
			.where(eq(geoSamplingTargets.id, targetId))
			.returning();
		await writeGeoAudit(tx, {
			principal,
			action: enabled ? "target.enable" : "target.disable",
			entityType: "sampling_target",
			entityId: targetId,
			before,
			after,
		});
		return after;
	});
}

const CREDENTIAL_SHAPE = /^[\x21-\x7e]{8,4096}$/;

/** Stores the credential encrypted and points the target at it. The value appears in no response, log or audit row. */
export async function setSamplingTargetCredential(
	principal: GeoPrincipal,
	targetId: string,
	value: string | null,
): Promise<{ credentialConfigured: boolean }> {
	assertGeoPermission(principal, "secret.manage");
	const trimmed = value?.trim() ?? null;
	if (trimmed !== null && !CREDENTIAL_SHAPE.test(trimmed)) {
		throw new GeoError("VALIDATION_ERROR", "凭据格式无效：应为 8 位以上、不含空格的可见 ASCII 字符");
	}
	const target = await loadTarget(principal, targetId);
	if (target.surfaceMode === "MANUAL_EVIDENCE") throw new GeoError("VALIDATION_ERROR", "人工证据目标不需要凭据");
	const ref = targetCredentialRef(target.id);
	await db.transaction(async (tx) => {
		// A reference to a credential shared through the settings page is only let go of, never deleted.
		if (trimmed === null) await deleteGeoCredential(tx, principal.organizationId, ref);
		else await putGeoCredential(tx, principal.organizationId, ref, trimmed);
		await tx
			.update(geoSamplingTargets)
			.set({ credentialRef: trimmed === null ? null : ref })
			.where(eq(geoSamplingTargets.id, target.id));
		await writeGeoAudit(tx, {
			principal,
			action: trimmed === null ? "target.credential.clear" : "target.credential.set",
			entityType: "sampling_target",
			entityId: target.id,
			metadata: { ref },
		});
	});
	return { credentialConfigured: trimmed !== null };
}

export interface ConnectivityResult {
	available: boolean;
	detail: string;
	checkedAt: string;
}

/**
 * Asks the adapter whether the source answers, without sending a question: a model list
 * call for an API, the vendor's health endpoint for a licensed service. Recording a
 * verdict is a separate, deliberate step.
 */
export async function checkSamplingTargetConnectivity(
	principal: GeoPrincipal,
	targetId: string,
): Promise<ConnectivityResult> {
	assertGeoPermission(principal, "target.manage");
	const target = await loadTarget(principal, targetId);
	const credential = await readTargetCredential(principal.organizationId, target.credentialRef);
	const adapter = createCaptureAdapter(target, { credential, timeoutMs: 15_000 });
	let result: { available: boolean; detail: string };
	try {
		const capabilities = await adapter.capabilities();
		result = { available: capabilities.available, detail: capabilities.detail ?? "" };
	} catch {
		result = { available: false, detail: "检测过程中发生未预期的错误" };
	}
	const detail = redactSecrets(result.detail, [credential]).slice(0, 500);
	const checkedAt = new Date().toISOString();
	await db.transaction((tx) =>
		writeGeoAudit(tx, {
			principal,
			action: "target.connectivity_check",
			entityType: "sampling_target",
			entityId: target.id,
			metadata: { available: result.available, detail },
		}),
	);
	return { available: result.available, detail, checkedAt };
}

/** Only an administrator records whether a source passed, with the basis for it, in the audit log. */
export async function setSamplingTargetVerification(
	principal: GeoPrincipal,
	targetId: string,
	input: z.infer<typeof verificationInputSchema>,
): Promise<SamplingTargetRow> {
	assertGeoPermission(principal, "target.manage");
	return db.transaction(async (tx) => {
		const [before] = await tx
			.select()
			.from(geoSamplingTargets)
			.where(and(eq(geoSamplingTargets.id, targetId), eq(geoSamplingTargets.organizationId, principal.organizationId)))
			.for("update");
		if (!before) throw new GeoError("NOT_FOUND", "采样目标不存在");
		const verified = input.status !== "UNVERIFIED";
		const [after] = await tx
			.update(geoSamplingTargets)
			.set({
				verificationStatus: input.status,
				verificationNote: input.note,
				verifiedBy: verified ? principal.actorId : null,
				verifiedAt: verified ? new Date() : null,
			})
			.where(eq(geoSamplingTargets.id, targetId))
			.returning();
		await writeGeoAudit(tx, {
			principal,
			action: "target.verification",
			entityType: "sampling_target",
			entityId: targetId,
			before,
			after,
			metadata: { from: before.verificationStatus, to: input.status, note: input.note },
		});
		return after;
	});
}
