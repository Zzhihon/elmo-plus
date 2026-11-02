import {
	GeoError,
	type GeoPlatform,
	type GeoPriority,
	type GeoSurfaceMode,
	type GeoVerificationStatus,
	samplingSlotKey,
} from "@workspace/geo-domain";
import type { DbConnection } from "@workspace/lib/db/db-connection";
import {
	geoBrandEntities,
	geoEvaluations,
	geoObservationClaims,
	geoObservations,
	geoPromptSetItems,
	geoPromptSets,
	geoPrompts,
	geoSamplingBatches,
	geoSamplingRuns,
	geoSamplingTargets,
} from "@workspace/lib/db/schema";
import { and, desc, eq, gte, inArray, isNull, lt, max, type SQL, sql } from "drizzle-orm";
import type { CompetitorRef, MetricClaim, MetricSample, PlannedSlot } from "../metrics";
import type { ReportTarget } from "../report";

/** A window larger than this is refused rather than computed slowly. */
export const GEO_MAX_METRIC_SAMPLES = 50_000;

export interface MetricFilter {
	from: Date;
	/** Exclusive. */
	to: Date;
	promptSetId?: string | null;
	platform?: GeoPlatform;
	surfaceMode?: GeoSurfaceMode;
	promptId?: string;
}

const WEEK_MS = 7 * 86_400_000;
const CHINA_OFFSET_MS = 8 * 3_600_000;

/** Manual evidence has no batch, so its round is the China-time week (Monday start) it was sampled in. */
export function manualRound(sampledAt: Date): { key: string; startedAt: string } {
	const local = sampledAt.getTime() + CHINA_OFFSET_MS;
	const day = new Date(local).getUTCDay();
	const monday = Math.floor(local / 86_400_000) * 86_400_000 - ((day + 6) % 7) * 86_400_000;
	const start = new Date(monday - CHINA_OFFSET_MS);
	return { key: `week:${new Date(monday).toISOString().slice(0, 10)}`, startedAt: start.toISOString() };
}

function sampleColumns() {
	const o = geoObservations;
	const e = geoEvaluations;
	return {
		id: o.id,
		runId: o.runId,
		promptId: o.promptId,
		questionText: o.questionText,
		targetId: o.targetId,
		platform: o.platform,
		surfaceMode: o.surfaceMode,
		status: o.status,
		sampledAt: o.sampledAt,
		createdAt: o.createdAt,
		promptSetId: o.promptSetId,
		batchId: geoSamplingRuns.batchId,
		repeatIndex: geoSamplingRuns.repeatIndex,
		batchCreatedAt: geoSamplingBatches.createdAt,
		region: geoSamplingTargets.region,
		language: geoSamplingTargets.language,
		setVersion: geoPromptSets.version,
		priority: sql<GeoPriority | null>`coalesce(${geoPromptSetItems.labels}->>'priority', ${geoPrompts.priority})`,
		evaluationId: e.id,
		evaluationVersion: e.version,
		evaluatorVersion: e.evaluatorVersion,
		brandMentioned: e.brandMentioned,
		recommendation: e.recommendation,
		hasOrderedList: e.hasOrderedList,
		brandRank: e.brandRank,
		competitorHits: e.competitorHits,
		citationAttribution: e.citationAttribution,
		reviewStatus: e.reviewStatus,
		evaluatedAt: e.createdAt,
	};
}

type SampleRow = Awaited<ReturnType<typeof selectSampleRows>>[number];

function selectSampleRows(db: DbConnection, where: SQL | undefined, limit: number) {
	const o = geoObservations;
	return db
		.select(sampleColumns())
		.from(o)
		.innerJoin(geoSamplingTargets, eq(geoSamplingTargets.id, o.targetId))
		.innerJoin(geoPrompts, eq(geoPrompts.id, o.promptId))
		.leftJoin(geoSamplingRuns, eq(geoSamplingRuns.id, o.runId))
		.leftJoin(geoSamplingBatches, eq(geoSamplingBatches.id, geoSamplingRuns.batchId))
		.leftJoin(geoPromptSets, eq(geoPromptSets.id, o.promptSetId))
		.leftJoin(
			geoPromptSetItems,
			and(eq(geoPromptSetItems.setId, o.promptSetId), eq(geoPromptSetItems.promptId, o.promptId)),
		)
		.leftJoin(geoEvaluations, and(eq(geoEvaluations.observationId, o.id), eq(geoEvaluations.isCurrent, true)))
		.where(where)
		.limit(limit);
}

async function claimsByObservation(db: DbConnection, ids: readonly string[]): Promise<Map<string, MetricClaim[]>> {
	const claims = new Map<string, MetricClaim[]>();
	for (let index = 0; index < ids.length; index += 5000) {
		const chunk = ids.slice(index, index + 5000);
		const rows = await db
			.select({
				observationId: geoObservationClaims.observationId,
				verdict: geoObservationClaims.verdict,
				matchStatus: geoObservationClaims.matchStatus,
			})
			.from(geoObservationClaims)
			.where(inArray(geoObservationClaims.observationId, chunk));
		for (const row of rows) {
			const list = claims.get(row.observationId) ?? [];
			list.push({ verdict: row.verdict, matchStatus: row.matchStatus });
			claims.set(row.observationId, list);
		}
	}
	return claims;
}

function toSample(row: SampleRow, claims: Map<string, MetricClaim[]>): MetricSample {
	const round =
		row.batchId && row.batchCreatedAt
			? { key: `batch:${row.batchId}`, startedAt: row.batchCreatedAt.toISOString() }
			: manualRound(row.sampledAt);
	const slotKey =
		row.batchId && row.repeatIndex !== null
			? samplingSlotKey({
					batchId: row.batchId,
					promptId: row.promptId,
					targetId: row.targetId,
					repeatIndex: row.repeatIndex,
				})
			: `observation:${row.id}`;
	return {
		observationId: row.id,
		slotKey,
		roundKey: round.key,
		roundStartedAt: round.startedAt,
		promptId: row.promptId,
		questionText: row.questionText,
		promptPriority: row.priority,
		platform: row.platform,
		surfaceMode: row.surfaceMode,
		targetId: row.targetId,
		region: row.region,
		language: row.language,
		promptSetId: row.promptSetId,
		promptSetVersion: row.setVersion,
		status: row.status,
		sampledAt: row.sampledAt.toISOString(),
		evaluation:
			row.evaluationId && row.recommendation && row.reviewStatus && row.evaluatorVersion
				? {
						evaluationId: row.evaluationId,
						version: row.evaluationVersion ?? 1,
						evaluatorVersion: row.evaluatorVersion,
						brandMentioned: row.brandMentioned ?? false,
						recommendation: row.recommendation,
						hasOrderedList: row.hasOrderedList ?? false,
						brandRank: row.brandRank,
						competitorHits: row.competitorHits ?? [],
						citations: row.citationAttribution ?? [],
						reviewStatus: row.reviewStatus,
					}
				: null,
		claims: claims.get(row.id) ?? [],
	};
}

async function samplesWhere(db: DbConnection, where: SQL | undefined) {
	const rows = await selectSampleRows(db, where, GEO_MAX_METRIC_SAMPLES + 1);
	if (rows.length > GEO_MAX_METRIC_SAMPLES) {
		throw new GeoError("VALIDATION_ERROR", "所选范围内样本过多，请缩短时间窗口或限定平台");
	}
	const claims = await claimsByObservation(
		db,
		rows.map((row) => row.id),
	);
	let updatedAt: Date | null = null;
	for (const row of rows) {
		for (const at of [row.createdAt, row.evaluatedAt]) if (at && (!updatedAt || at > updatedAt)) updatedAt = at;
	}
	return { samples: rows.map((row) => toSample(row, claims)), updatedAt };
}

function observationConditions(organizationId: string, filter: MetricFilter): SQL | undefined {
	const o = geoObservations;
	return and(
		eq(o.organizationId, organizationId),
		gte(o.sampledAt, filter.from),
		lt(o.sampledAt, filter.to),
		filter.promptSetId ? eq(o.promptSetId, filter.promptSetId) : undefined,
		filter.platform ? eq(o.platform, filter.platform) : undefined,
		filter.surfaceMode ? eq(o.surfaceMode, filter.surfaceMode) : undefined,
		filter.promptId ? eq(o.promptId, filter.promptId) : undefined,
	);
}

/** Every planned sample in the window: run slots of batches started in it, plus each manual import. */
async function plannedSlots(db: DbConnection, organizationId: string, filter: MetricFilter): Promise<PlannedSlot[]> {
	const r = geoSamplingRuns;
	const t = geoSamplingTargets;
	const runs = await db
		.select({
			batchId: r.batchId,
			promptId: r.promptId,
			targetId: r.targetId,
			repeatIndex: r.repeatIndex,
			status: r.status,
			updatedAt: r.updatedAt,
			platform: t.platform,
			surfaceMode: t.surfaceMode,
		})
		.from(r)
		.innerJoin(geoSamplingBatches, eq(geoSamplingBatches.id, r.batchId))
		.innerJoin(t, eq(t.id, r.targetId))
		.where(
			and(
				eq(r.organizationId, organizationId),
				gte(geoSamplingBatches.createdAt, filter.from),
				lt(geoSamplingBatches.createdAt, filter.to),
				filter.promptSetId ? eq(geoSamplingBatches.promptSetId, filter.promptSetId) : undefined,
				filter.platform ? eq(t.platform, filter.platform) : undefined,
				filter.surfaceMode ? eq(t.surfaceMode, filter.surfaceMode) : undefined,
				filter.promptId ? eq(r.promptId, filter.promptId) : undefined,
			),
		)
		.limit(GEO_MAX_METRIC_SAMPLES + 1);
	if (runs.length > GEO_MAX_METRIC_SAMPLES) {
		throw new GeoError("VALIDATION_ERROR", "所选范围内计划采样过多，请缩短时间窗口或限定平台");
	}
	const o = geoObservations;
	const manual = await db
		.select({ id: o.id, status: o.status, sampledAt: o.sampledAt, platform: o.platform, surfaceMode: o.surfaceMode })
		.from(o)
		.where(and(observationConditions(organizationId, filter), isNull(o.runId)))
		.limit(GEO_MAX_METRIC_SAMPLES);
	return [
		...runs.map((run) => ({
			slotKey: samplingSlotKey(run),
			platform: run.platform,
			surfaceMode: run.surfaceMode,
			status: run.status,
			sampledAt: run.updatedAt.toISOString(),
		})),
		...manual.map((row) => ({
			slotKey: `observation:${row.id}`,
			platform: row.platform,
			surfaceMode: row.surfaceMode,
			status: row.status,
			sampledAt: row.sampledAt.toISOString(),
		})),
	];
}

async function competitorRefs(
	db: DbConnection,
	organizationId: string,
	samples: readonly MetricSample[],
): Promise<CompetitorRef[]> {
	const active = await db
		.select({ entityId: geoBrandEntities.id, name: geoBrandEntities.displayName })
		.from(geoBrandEntities)
		.where(
			and(
				eq(geoBrandEntities.organizationId, organizationId),
				eq(geoBrandEntities.kind, "COMPETITOR"),
				eq(geoBrandEntities.status, "ACTIVE"),
			),
		);
	const refs = new Map(active.map((row) => [row.entityId, row]));
	for (const sample of samples) {
		for (const hit of sample.evaluation?.competitorHits ?? []) {
			if (!refs.has(hit.entityId)) refs.set(hit.entityId, { entityId: hit.entityId, name: hit.name ?? hit.entityId });
		}
	}
	return [...refs.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function targetsOf(db: DbConnection, organizationId: string, ids: readonly string[]): Promise<ReportTarget[]> {
	if (ids.length === 0) return [];
	const rows = await db
		.select({
			id: geoSamplingTargets.id,
			platform: geoSamplingTargets.platform,
			surfaceMode: geoSamplingTargets.surfaceMode,
			provider: geoSamplingTargets.provider,
			modelId: geoSamplingTargets.modelId,
			verificationStatus: geoSamplingTargets.verificationStatus,
		})
		.from(geoSamplingTargets)
		.where(and(eq(geoSamplingTargets.organizationId, organizationId), inArray(geoSamplingTargets.id, [...ids])));
	return rows.map((row) => ({ ...row, verificationStatus: row.verificationStatus as GeoVerificationStatus }));
}

export interface PromptSetRef {
	id: string;
	name: string;
	version: number;
}

/** The question set most sampled in the window, so a page opens on one fixed comparison set rather than a mix. */
export async function defaultPromptSet(
	db: DbConnection,
	organizationId: string,
	window: { from: Date; to: Date },
): Promise<PromptSetRef | null> {
	const [row] = await db
		.select({ id: geoPromptSets.id, name: geoPromptSets.name, version: geoPromptSets.version })
		.from(geoObservations)
		.innerJoin(geoPromptSets, eq(geoPromptSets.id, geoObservations.promptSetId))
		.where(
			and(
				eq(geoObservations.organizationId, organizationId),
				gte(geoObservations.sampledAt, window.from),
				lt(geoObservations.sampledAt, window.to),
			),
		)
		.groupBy(geoPromptSets.id, geoPromptSets.name, geoPromptSets.version)
		.orderBy(desc(sql`count(*)`), desc(max(geoObservations.sampledAt)))
		.limit(1);
	return row ?? null;
}

/** Question sets that have any observation, newest first: the choices for a comparison filter. */
export async function sampledPromptSets(
	db: DbConnection,
	organizationId: string,
): Promise<(PromptSetRef & { observations: number })[]> {
	return db
		.select({
			id: geoPromptSets.id,
			name: geoPromptSets.name,
			version: geoPromptSets.version,
			observations: sql<number>`count(*)::int`,
		})
		.from(geoObservations)
		.innerJoin(geoPromptSets, eq(geoPromptSets.id, geoObservations.promptSetId))
		.where(eq(geoObservations.organizationId, organizationId))
		.groupBy(geoPromptSets.id, geoPromptSets.name, geoPromptSets.version)
		.orderBy(desc(max(geoObservations.sampledAt)))
		.limit(200);
}

export async function promptSetRef(
	db: DbConnection,
	organizationId: string,
	promptSetId: string,
): Promise<PromptSetRef | null> {
	const [row] = await db
		.select({ id: geoPromptSets.id, name: geoPromptSets.name, version: geoPromptSets.version })
		.from(geoPromptSets)
		.where(and(eq(geoPromptSets.organizationId, organizationId), eq(geoPromptSets.id, promptSetId)));
	return row ?? null;
}

export interface MetricData {
	samples: MetricSample[];
	slots: PlannedSlot[];
	competitors: CompetitorRef[];
	targets: ReportTarget[];
	updatedAt: string | null;
}

export async function loadMetricData(
	db: DbConnection,
	organizationId: string,
	filter: MetricFilter,
): Promise<MetricData> {
	const [{ samples, updatedAt }, slots] = await Promise.all([
		samplesWhere(db, observationConditions(organizationId, filter)),
		plannedSlots(db, organizationId, filter),
	]);
	const targetIds = [...new Set(samples.map((sample) => sample.targetId))];
	const [competitors, targets] = await Promise.all([
		competitorRefs(db, organizationId, samples),
		targetsOf(db, organizationId, targetIds),
	]);
	return { samples, slots, competitors, targets, updatedAt: updatedAt?.toISOString() ?? null };
}

/** All observations of one batch, re-samples included: the input for a round-to-round comparison. */
export async function loadBatchSamples(
	db: DbConnection,
	organizationId: string,
	batchId: string,
	promptId?: string | null,
): Promise<MetricSample[]> {
	const { samples } = await samplesWhere(
		db,
		and(
			eq(geoObservations.organizationId, organizationId),
			eq(geoSamplingRuns.batchId, batchId),
			promptId ? eq(geoObservations.promptId, promptId) : undefined,
		),
	);
	return samples;
}
