import {
	assertGeoPermission,
	countsAsValidSample,
	GEO_OBSERVATION_STATUSES,
	GEO_PLATFORMS,
	GEO_SURFACE_MODE_LABELS,
	GEO_SURFACE_MODES,
	GeoError,
	type GeoObservationEvidencePointer,
	type GeoPrincipal,
	observationEvidenceOwnership,
} from "@workspace/geo-domain";
import { getObjectStore } from "@workspace/geo-evidence";
import { db } from "@workspace/lib/db/db";
import {
	geoEvaluations,
	geoEvidenceUploads,
	geoObservationCitations,
	geoObservations,
	geoPromptSets,
	geoSamplingAttempts,
	geoSamplingRuns,
	geoSamplingTargets,
} from "@workspace/lib/db/schema";
import { and, asc, count, desc, eq, gte, ilike, lt, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import { asJsonObject, type JsonObject } from "./sampling-json";

type Paging = { page: number; limit: number; offset: number };

export const observationListQuerySchema = z.object({
	promptId: z.guid().optional(),
	promptSetId: z.guid().optional(),
	targetId: z.guid().optional(),
	batchId: z.guid().optional(),
	platform: z.enum(GEO_PLATFORMS).optional(),
	surfaceMode: z.enum(GEO_SURFACE_MODES).optional(),
	status: z.enum(GEO_OBSERVATION_STATUSES).optional(),
	q: z.string().trim().max(200).optional(),
	from: z.iso.date().optional(),
	to: z.iso.date().optional(),
});
export type ObservationListQuery = z.infer<typeof observationListQuerySchema>;

export interface ObservationListItem {
	id: string;
	promptId: string;
	questionText: string;
	platform: (typeof GEO_PLATFORMS)[number];
	surfaceMode: (typeof GEO_SURFACE_MODES)[number];
	status: (typeof GEO_OBSERVATION_STATUSES)[number];
	sampledAt: string;
	errorCode: string | null;
	citationCount: number;
	countsInRates: boolean;
	imported: boolean;
	retryOfObservationId: string | null;
	evaluation: { recommendation: string; brandMentioned: boolean; reviewStatus: string } | null;
}

function escapeLike(value: string): string {
	return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/** Dates are calendar days in China Standard Time, the zone the people filtering think in. */
function dayStart(date: string): Date {
	return new Date(`${date}T00:00:00+08:00`);
}

function listConditions(organizationId: string, query: ObservationListQuery): SQL[] {
	const o = geoObservations;
	const conditions: (SQL | undefined)[] = [
		eq(o.organizationId, organizationId),
		query.promptId ? eq(o.promptId, query.promptId) : undefined,
		query.promptSetId ? eq(o.promptSetId, query.promptSetId) : undefined,
		query.targetId ? eq(o.targetId, query.targetId) : undefined,
		query.platform ? eq(o.platform, query.platform) : undefined,
		query.surfaceMode ? eq(o.surfaceMode, query.surfaceMode) : undefined,
		query.status ? eq(o.status, query.status) : undefined,
		query.q ? ilike(o.questionText, `%${escapeLike(query.q)}%`) : undefined,
		query.from ? gte(o.sampledAt, dayStart(query.from)) : undefined,
		query.to ? lt(o.sampledAt, new Date(dayStart(query.to).getTime() + 86_400_000)) : undefined,
		query.batchId
			? sql`${o.runId} in (select ${geoSamplingRuns.id} from ${geoSamplingRuns} where ${geoSamplingRuns.batchId} = ${query.batchId})`
			: undefined,
	];
	return conditions.filter((condition): condition is SQL => condition !== undefined);
}

/** Searchable by question, platform, mode, status and day, newest first. */
export async function listObservations(
	principal: GeoPrincipal,
	query: ObservationListQuery,
	paging: Paging,
): Promise<{ rows: ObservationListItem[]; total: number }> {
	assertGeoPermission(principal, "observation.read");
	const o = geoObservations;
	const where = and(...listConditions(principal.organizationId, query));
	const [rows, [total]] = await Promise.all([
		db
			.select({
				observation: {
					id: o.id,
					promptId: o.promptId,
					questionText: o.questionText,
					platform: o.platform,
					surfaceMode: o.surfaceMode,
					status: o.status,
					sampledAt: o.sampledAt,
					errorCode: o.errorCode,
					importBatchId: o.importBatchId,
					retryOfObservationId: o.retryOfObservationId,
				},
				citationCount: sql<number>`(select count(*)::int from ${geoObservationCitations} where ${geoObservationCitations.observationId} = ${o.id})`,
				recommendation: geoEvaluations.recommendation,
				brandMentioned: geoEvaluations.brandMentioned,
				reviewStatus: geoEvaluations.reviewStatus,
			})
			.from(o)
			.leftJoin(geoEvaluations, and(eq(geoEvaluations.observationId, o.id), eq(geoEvaluations.isCurrent, true)))
			.where(where)
			.orderBy(desc(o.sampledAt), desc(o.createdAt))
			.limit(paging.limit)
			.offset(paging.offset),
		db.select({ value: count() }).from(o).where(where),
	]);
	return {
		rows: rows.map(({ observation, citationCount, recommendation, brandMentioned, reviewStatus }) => ({
			id: observation.id,
			promptId: observation.promptId,
			questionText: observation.questionText,
			platform: observation.platform,
			surfaceMode: observation.surfaceMode,
			status: observation.status,
			sampledAt: observation.sampledAt.toISOString(),
			errorCode: observation.errorCode,
			citationCount,
			countsInRates: countsAsValidSample(observation.status),
			imported: observation.importBatchId !== null,
			retryOfObservationId: observation.retryOfObservationId,
			evaluation:
				recommendation !== null && brandMentioned !== null && reviewStatus !== null
					? { recommendation, brandMentioned, reviewStatus }
					: null,
		})),
		total: total.value,
	};
}

export type EvidenceKind = "object" | "url" | "note" | "none";

/** The object an observation really owns, or null when its pointer is only text or a link. */
async function ownedEvidenceObject(observation: GeoObservationEvidencePointer): Promise<string | null> {
	const ownership = observationEvidenceOwnership(observation);
	if (!ownership || !observation.evidenceUri) return null;
	if (ownership === "RUN") return observation.evidenceUri;
	if (!observation.importBatchId) return null;
	const [upload] = await db
		.select({ id: geoEvidenceUploads.id })
		.from(geoEvidenceUploads)
		.where(
			and(
				eq(geoEvidenceUploads.organizationId, observation.organizationId),
				eq(geoEvidenceUploads.objectKey, observation.evidenceUri),
				eq(geoEvidenceUploads.importBatchId, observation.importBatchId),
			),
		)
		.limit(1);
	return upload ? observation.evidenceUri : null;
}

function evidenceKind(uri: string | null, ownedObject: string | null): EvidenceKind {
	if (!uri) return "none";
	if (ownedObject) return "object";
	return /^https?:\/\//i.test(uri) ? "url" : "note";
}

export interface ObservationDetail {
	id: string;
	promptId: string;
	promptSet: { id: string; name: string; version: number } | null;
	promptRevision: number;
	questionText: string;
	target: {
		id: string;
		platform: (typeof GEO_PLATFORMS)[number];
		surfaceMode: (typeof GEO_SURFACE_MODES)[number];
		provider: string;
		modelId: string | null;
		region: string | null;
		language: string;
		verificationStatus: string;
		verificationNote: string | null;
	};
	status: (typeof GEO_OBSERVATION_STATUSES)[number];
	countsInRates: boolean;
	responseText: string | null;
	sampledAt: string;
	responseMetadata: JsonObject;
	providerVersion: string | null;
	modelVersion: string | null;
	sourceMethodVersion: string | null;
	errorCode: string | null;
	evidence: { kind: EvidenceKind; location: string | null };
	citations: {
		ordinal: number;
		url: string;
		normalizedUrl: string | null;
		host: string | null;
		title: string | null;
	}[];
	run: {
		id: string;
		batchId: string;
		repeatIndex: number;
		status: string;
		retryRelation: string | null;
		retryOfRunId: string | null;
		attempts: {
			attemptNo: number;
			startedAt: string;
			durationMs: number | null;
			status: string;
			errorCode: string | null;
			costEstimate: number | null;
			providerTraceId: string | null;
		}[];
	} | null;
	import: { importBatchId: string; importedBy: string | null } | null;
	retryOf: { id: string; status: string; sampledAt: string } | null;
	resamples: { id: string; status: string; sampledAt: string }[];
	evaluations: {
		id: string;
		version: number;
		evaluatorVersion: string;
		recommendation: string;
		brandMentioned: boolean;
		brandRank: number | null;
		confidence: number | null;
		reviewStatus: string;
		isCurrent: boolean;
		createdBy: string;
		reason: string | null;
		createdAt: string;
	}[];
	createdAt: string;
}

async function loadRun(runId: string | null): Promise<ObservationDetail["run"]> {
	if (!runId) return null;
	const [run] = await db.select().from(geoSamplingRuns).where(eq(geoSamplingRuns.id, runId));
	if (!run) return null;
	const attempts = await db
		.select()
		.from(geoSamplingAttempts)
		.where(eq(geoSamplingAttempts.runId, runId))
		.orderBy(asc(geoSamplingAttempts.attemptNo));
	return {
		id: run.id,
		batchId: run.batchId,
		repeatIndex: run.repeatIndex,
		status: run.status,
		retryRelation: run.retryRelation,
		retryOfRunId: run.retryOfRunId,
		attempts: attempts.map((attempt) => ({
			attemptNo: attempt.attemptNo,
			startedAt: attempt.startedAt.toISOString(),
			durationMs: attempt.durationMs,
			status: attempt.status,
			errorCode: attempt.errorCode,
			costEstimate: attempt.costEstimate === null ? null : Number(attempt.costEstimate),
			providerTraceId: attempt.providerTraceId,
		})),
	};
}

async function retryLinks(organizationId: string, observationId: string, retryOfId: string | null) {
	const brief = { id: geoObservations.id, status: geoObservations.status, sampledAt: geoObservations.sampledAt };
	const [retryOf, resamples] = await Promise.all([
		retryOfId
			? db
					.select(brief)
					.from(geoObservations)
					.where(and(eq(geoObservations.id, retryOfId), eq(geoObservations.organizationId, organizationId)))
			: Promise.resolve([]),
		db
			.select(brief)
			.from(geoObservations)
			.where(
				and(
					eq(geoObservations.retryOfObservationId, observationId),
					eq(geoObservations.organizationId, organizationId),
				),
			)
			.orderBy(asc(geoObservations.sampledAt)),
	]);
	const toBrief = (row: { id: string; status: string; sampledAt: Date }) => ({
		id: row.id,
		status: row.status,
		sampledAt: row.sampledAt.toISOString(),
	});
	return { retryOf: retryOf[0] ? toBrief(retryOf[0]) : null, resamples: resamples.map(toBrief) };
}

export async function getObservation(principal: GeoPrincipal, observationId: string): Promise<ObservationDetail> {
	assertGeoPermission(principal, "observation.read");
	const [row] = await db
		.select({
			observation: geoObservations,
			target: geoSamplingTargets,
			set: { id: geoPromptSets.id, name: geoPromptSets.name, version: geoPromptSets.version },
		})
		.from(geoObservations)
		.innerJoin(geoSamplingTargets, eq(geoSamplingTargets.id, geoObservations.targetId))
		.leftJoin(geoPromptSets, eq(geoPromptSets.id, geoObservations.promptSetId))
		.where(and(eq(geoObservations.id, observationId), eq(geoObservations.organizationId, principal.organizationId)));
	if (!row) throw new GeoError("NOT_FOUND", "证据不存在");
	const { observation, target } = row;

	const [citations, evaluations, run, links, ownedObject] = await Promise.all([
		db
			.select()
			.from(geoObservationCitations)
			.where(eq(geoObservationCitations.observationId, observation.id))
			.orderBy(asc(geoObservationCitations.ordinal)),
		db
			.select()
			.from(geoEvaluations)
			.where(eq(geoEvaluations.observationId, observation.id))
			.orderBy(desc(geoEvaluations.version)),
		loadRun(observation.runId),
		retryLinks(principal.organizationId, observation.id, observation.retryOfObservationId),
		ownedEvidenceObject(observation),
	]);

	return {
		id: observation.id,
		promptId: observation.promptId,
		promptSet: row.set?.id ? row.set : null,
		promptRevision: observation.promptRevision,
		questionText: observation.questionText,
		target: {
			id: target.id,
			platform: target.platform,
			surfaceMode: target.surfaceMode,
			provider: target.provider,
			modelId: target.modelId,
			region: target.region,
			language: target.language,
			verificationStatus: target.verificationStatus,
			verificationNote: target.verificationNote,
		},
		status: observation.status,
		countsInRates: countsAsValidSample(observation.status),
		responseText: observation.responseText,
		sampledAt: observation.sampledAt.toISOString(),
		responseMetadata: asJsonObject(observation.responseMetadata),
		providerVersion: observation.providerVersion,
		modelVersion: observation.modelVersion,
		sourceMethodVersion: observation.sourceMethodVersion,
		errorCode: observation.errorCode,
		evidence: {
			kind: evidenceKind(observation.evidenceUri, ownedObject),
			location: observation.evidenceUri,
		},
		citations: citations.map((citation) => ({
			ordinal: citation.ordinal,
			url: citation.url,
			normalizedUrl: citation.normalizedUrl,
			host: citation.host,
			title: citation.title,
		})),
		run,
		import: observation.importBatchId
			? { importBatchId: observation.importBatchId, importedBy: observation.importedBy }
			: null,
		...links,
		evaluations: evaluations.map((evaluation) => ({
			id: evaluation.id,
			version: evaluation.version,
			evaluatorVersion: evaluation.evaluatorVersion,
			recommendation: evaluation.recommendation,
			brandMentioned: evaluation.brandMentioned,
			brandRank: evaluation.brandRank,
			confidence: evaluation.confidence,
			reviewStatus: evaluation.reviewStatus,
			isCurrent: evaluation.isCurrent,
			createdBy: evaluation.createdBy,
			reason: evaluation.reason,
			createdAt: evaluation.createdAt.toISOString(),
		})),
		createdAt: observation.createdAt.toISOString(),
	};
}

export const OBSERVATION_EXPORT_FORMAT = "elmo-geo-observation/1";

/**
 * A self-contained record a customer can check on its own: the question and answer as
 * captured, how they were captured, every evaluation version, and where the original
 * evidence lives. Downloading it is logged.
 */
export async function exportObservation(principal: GeoPrincipal, observationId: string) {
	const detail = await getObservation(principal, observationId);
	const modeLabel = GEO_SURFACE_MODE_LABELS[detail.target.surfaceMode];
	return {
		format: OBSERVATION_EXPORT_FORMAT,
		exportedAt: new Date().toISOString(),
		exportedBy: principal.actorId,
		method: {
			surfaceMode: detail.target.surfaceMode,
			surfaceModeLabel: modeLabel,
			note:
				detail.target.surfaceMode === "MODEL_API"
					? "本记录来自模型 API 代理评测，不等同于该平台面向用户的产品回答。"
					: detail.target.surfaceMode === "MANUAL_EVIDENCE"
						? "本记录为人工采样导入，证据位置见 evidence。"
						: "本记录来自已获许可的第三方服务采集的用户界面回答。",
			targetVerificationStatus: detail.target.verificationStatus,
			countsInRates: detail.countsInRates,
		},
		observation: detail,
	};
}

/** Streams an evidence object, but only one that belongs to this organization's observation. */
export async function readObservationEvidence(principal: GeoPrincipal, observationId: string) {
	assertGeoPermission(principal, "observation.read");
	const [row] = await db
		.select({
			organizationId: geoObservations.organizationId,
			runId: geoObservations.runId,
			importBatchId: geoObservations.importBatchId,
			evidenceUri: geoObservations.evidenceUri,
		})
		.from(geoObservations)
		.where(and(eq(geoObservations.id, observationId), eq(geoObservations.organizationId, principal.organizationId)));
	if (!row) throw new GeoError("NOT_FOUND", "证据不存在");
	const key = await ownedEvidenceObject(row);
	if (!key) throw new GeoError("NOT_FOUND", "该证据没有存储在对象存储中");
	const object = await getObjectStore().get(key);
	if (!object) throw new GeoError("NOT_FOUND", "证据文件已不存在");
	const name = key.split("/").pop() ?? "evidence";
	return { ...object, name };
}
