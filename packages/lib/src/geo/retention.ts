import {
	type GeoRetentionCategory,
	type GeoRetentionSettings,
	geoSystemPrincipal,
	retentionCutoff,
} from "@workspace/geo-domain";
import { and, eq, inArray, lt, notInArray, or, sql } from "drizzle-orm";
import type { db as Database } from "../db/db";
import type { DbConnection } from "../db/db-connection";
import {
	geoAuditLogs,
	geoEvaluations,
	geoObservationCitations,
	geoObservationClaims,
	geoObservations,
	geoSitePageVersions,
	geoTaskEvidence,
} from "../db/schema-geo";
import { writeGeoAudit } from "./audit";

/**
 * Deletes what an organization's retention settings say has expired. Nothing is
 * configured by default, so nothing is deleted by default.
 *
 * Each batch is one transaction that sets `geo.retention_purge` locally (the only
 * way past the append-only triggers), deletes dependants before what they point
 * at, and writes its own summary audit row. Object-store files go only after the
 * transaction commits, so a rollback never leaves rows pointing at deleted files.
 */

type Db = typeof Database;

export interface GeoRetentionDeps {
	deleteObject: (key: string) => Promise<void>;
	now?: Date;
	batchSize?: number;
	requestId?: string;
}

export interface GeoRetentionCategoryResult {
	cutoff: string | null;
	rows: Record<string, number>;
	objectsDeleted: number;
	objectFailures: number;
}

export type GeoRetentionResult = Record<GeoRetentionCategory, GeoRetentionCategoryResult>;

const DEFAULT_BATCH = 500;

function emptyResult(cutoff: Date | null): GeoRetentionCategoryResult {
	return { cutoff: cutoff?.toISOString() ?? null, rows: {}, objectsDeleted: 0, objectFailures: 0 };
}

function add(result: GeoRetentionCategoryResult, rows: Record<string, number>): void {
	for (const [table, count] of Object.entries(rows)) result.rows[table] = (result.rows[table] ?? 0) + count;
}

async function allowPurge(tx: DbConnection): Promise<void> {
	await tx.execute(sql`select set_config('geo.retention_purge', 'on', true)`);
}

/** Only keys this organization's evidence was written under are ever deleted. */
function ownedKey(organizationId: string, key: string | null): key is string {
	return typeof key === "string" && key.startsWith(`geo/${organizationId}/`);
}

async function deleteObjects(
	keys: string[],
	deps: GeoRetentionDeps,
	result: GeoRetentionCategoryResult,
): Promise<void> {
	for (const key of keys) {
		try {
			await deps.deleteObject(key);
			result.objectsDeleted += 1;
		} catch (error) {
			result.objectFailures += 1;
			console.error(`[geo-retention] could not delete an expired object: ${(error as Error).message}`);
		}
	}
}

async function summarize(
	tx: DbConnection,
	organizationId: string,
	category: GeoRetentionCategory,
	cutoff: Date,
	rows: Record<string, number>,
	requestId: string,
): Promise<void> {
	await writeGeoAudit(tx, {
		principal: geoSystemPrincipal(organizationId, "retention", requestId),
		action: "retention.purge",
		entityType: "geo_retention",
		entityId: category,
		metadata: { category, cutoff: cutoff.toISOString(), rows },
	});
}

// ---------------------------------------------------------------------------
// Sampling evidence
// ---------------------------------------------------------------------------

/**
 * Newest first, and never a row that a kept observation's retry chain still
 * points at: `retry_of_observation_id` cannot be cleared on an immutable row, so a
 * parent has to outlive its newest descendant.
 */
async function expiredObservationBatch(
	tx: DbConnection,
	organizationId: string,
	cutoff: Date,
	limit: number,
): Promise<{ id: string; evidenceUri: string | null }[]> {
	const result = await tx.execute(sql`
		with recursive kept_refs(id) as (
			select retry_of_observation_id from geo_observations
			where organization_id = ${organizationId} and sampled_at >= ${cutoff} and retry_of_observation_id is not null
			union
			select o.retry_of_observation_id from geo_observations o join kept_refs k on o.id = k.id
			where o.retry_of_observation_id is not null
		)
		select o.id, o.evidence_uri from geo_observations o
		where o.organization_id = ${organizationId} and o.sampled_at < ${cutoff}
			and not exists (select 1 from kept_refs k where k.id = o.id)
		order by o.sampled_at desc, o.id desc
		limit ${limit}
	`);
	const rows = (result.rows as { id: string; evidence_uri: string | null }[]).map((row) => ({
		id: row.id,
		evidenceUri: row.evidence_uri,
	}));

	// A tie on sampled_at at the batch edge can still split a chain; drop whatever an
	// observation outside the batch still refers to, until nothing does.
	let ids = rows.map((row) => row.id);
	while (ids.length > 0) {
		const referenced = await tx
			.selectDistinct({ id: geoObservations.retryOfObservationId })
			.from(geoObservations)
			.where(and(inArray(geoObservations.retryOfObservationId, ids), notInArray(geoObservations.id, ids)));
		if (referenced.length === 0) break;
		const blocked = new Set(referenced.map((row) => row.id));
		ids = ids.filter((id) => !blocked.has(id));
	}
	const keep = new Set(ids);
	return rows.filter((row) => keep.has(row.id));
}

async function purgeEvidence(
	db: Db,
	organizationId: string,
	cutoff: Date,
	deps: GeoRetentionDeps,
	requestId: string,
): Promise<GeoRetentionCategoryResult> {
	const result = emptyResult(cutoff);
	const limit = deps.batchSize ?? DEFAULT_BATCH;
	for (;;) {
		const committed = await db.transaction(async (tx) => {
			const batch = await expiredObservationBatch(tx, organizationId, cutoff, limit);
			if (batch.length === 0) return null;
			const ids = batch.map((row) => row.id);
			await allowPurge(tx);

			const claims = await tx
				.delete(geoObservationClaims)
				.where(inArray(geoObservationClaims.observationId, ids))
				.returning({ id: geoObservationClaims.id });
			const taskEvidence = await tx
				.delete(geoTaskEvidence)
				.where(inArray(geoTaskEvidence.observationId, ids))
				.returning({ id: geoTaskEvidence.id });
			const evaluations = await tx
				.delete(geoEvaluations)
				.where(inArray(geoEvaluations.observationId, ids))
				.returning({ id: geoEvaluations.id });
			const citations = await tx
				.delete(geoObservationCitations)
				.where(inArray(geoObservationCitations.observationId, ids))
				.returning({ id: geoObservationCitations.id });
			const observations = await tx
				.delete(geoObservations)
				.where(and(eq(geoObservations.organizationId, organizationId), inArray(geoObservations.id, ids)))
				.returning({ id: geoObservations.id });

			const candidateKeys = [...new Set(batch.map((row) => row.evidenceUri))].filter((key) =>
				ownedKey(organizationId, key),
			);
			const stillUsed =
				candidateKeys.length === 0
					? []
					: await tx
							.select({ key: geoObservations.evidenceUri })
							.from(geoObservations)
							.where(inArray(geoObservations.evidenceUri, candidateKeys));
			const used = new Set(stillUsed.map((row) => row.key));

			const rows = {
				geo_observations: observations.length,
				geo_evaluations: evaluations.length,
				geo_observation_citations: citations.length,
				geo_observation_claims: claims.length,
				geo_task_evidence: taskEvidence.length,
			};
			await summarize(tx, organizationId, "evidence", cutoff, rows, requestId);
			return { rows, keys: candidateKeys.filter((key) => !used.has(key)), size: batch.length };
		});
		if (!committed) break;
		add(result, committed.rows);
		await deleteObjects(committed.keys, deps, result);
		if (committed.size < limit) break;
	}
	return result;
}

// ---------------------------------------------------------------------------
// Raw site snapshots
// ---------------------------------------------------------------------------

/**
 * The latest version of a page and any version a knowledge or entity source or an
 * audit finding cites stay, so neither a reviewed fact nor a finding loses its evidence.
 */
async function expiredPageVersionBatch(tx: DbConnection, organizationId: string, cutoff: Date, limit: number) {
	const result = await tx.execute(sql`
		select v.id, v.html_object_key, v.parsed_object_key from geo_site_page_versions v
		where v.organization_id = ${organizationId} and v.fetched_at < ${cutoff}
			and exists (
				select 1 from geo_site_page_versions n
				where n.page_id = v.page_id and (n.fetched_at > v.fetched_at or (n.fetched_at = v.fetched_at and n.id > v.id))
			)
			and not exists (select 1 from geo_assertion_sources s where s.page_version_id = v.id)
			and not exists (select 1 from geo_site_entity_sources e where e.page_version_id = v.id)
			and not exists (select 1 from geo_site_audit_findings f where f.page_version_id = v.id)
		order by v.fetched_at
		limit ${limit}
	`);
	return result.rows as { id: string; html_object_key: string; parsed_object_key: string | null }[];
}

async function purgeSnapshots(
	db: Db,
	organizationId: string,
	cutoff: Date,
	deps: GeoRetentionDeps,
	requestId: string,
): Promise<GeoRetentionCategoryResult> {
	const result = emptyResult(cutoff);
	const limit = deps.batchSize ?? DEFAULT_BATCH;
	for (;;) {
		const committed = await db.transaction(async (tx) => {
			const batch = await expiredPageVersionBatch(tx, organizationId, cutoff, limit);
			if (batch.length === 0) return null;
			await allowPurge(tx);
			const deleted = await tx
				.delete(geoSitePageVersions)
				.where(
					and(
						eq(geoSitePageVersions.organizationId, organizationId),
						inArray(
							geoSitePageVersions.id,
							batch.map((row) => row.id),
						),
					),
				)
				.returning({ id: geoSitePageVersions.id });

			// A reparse keeps the same HTML object, so a key leaves only once no version uses it.
			const candidateKeys = [...new Set(batch.flatMap((row) => [row.html_object_key, row.parsed_object_key]))].filter(
				(key) => ownedKey(organizationId, key),
			);
			const stillUsed =
				candidateKeys.length === 0
					? []
					: await tx
							.select({ html: geoSitePageVersions.htmlObjectKey, parsed: geoSitePageVersions.parsedObjectKey })
							.from(geoSitePageVersions)
							.where(
								or(
									inArray(geoSitePageVersions.htmlObjectKey, candidateKeys),
									inArray(geoSitePageVersions.parsedObjectKey, candidateKeys),
								),
							);
			const used = new Set(stillUsed.flatMap((row) => [row.html, row.parsed]));

			const rows = { geo_site_page_versions: deleted.length };
			await summarize(tx, organizationId, "snapshot", cutoff, rows, requestId);
			return { rows, keys: candidateKeys.filter((key) => !used.has(key)), size: batch.length };
		});
		if (!committed) break;
		add(result, committed.rows);
		await deleteObjects(committed.keys, deps, result);
		if (committed.size < limit) break;
	}
	return result;
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

async function purgeAudit(
	db: Db,
	organizationId: string,
	cutoff: Date,
	deps: GeoRetentionDeps,
	requestId: string,
): Promise<GeoRetentionCategoryResult> {
	const result = emptyResult(cutoff);
	const limit = deps.batchSize ?? DEFAULT_BATCH;
	for (;;) {
		const deleted = await db.transaction(async (tx) => {
			const ids = await tx
				.select({ id: geoAuditLogs.id })
				.from(geoAuditLogs)
				.where(and(eq(geoAuditLogs.organizationId, organizationId), lt(geoAuditLogs.createdAt, cutoff)))
				.orderBy(geoAuditLogs.createdAt)
				.limit(limit);
			if (ids.length === 0) return 0;
			await allowPurge(tx);
			const rows = await tx
				.delete(geoAuditLogs)
				.where(
					inArray(
						geoAuditLogs.id,
						ids.map((row) => row.id),
					),
				)
				.returning({ id: geoAuditLogs.id });
			// Written after the delete, and dated now, so the summary itself is never in scope.
			await summarize(tx, organizationId, "audit", cutoff, { geo_audit_logs: rows.length }, requestId);
			return rows.length;
		});
		add(result, { geo_audit_logs: deleted });
		if (deleted < limit) break;
	}
	return result;
}

export async function purgeExpiredGeoData(
	db: Db,
	organizationId: string,
	settings: GeoRetentionSettings,
	deps: GeoRetentionDeps,
): Promise<GeoRetentionResult> {
	const now = deps.now ?? new Date();
	const requestId = deps.requestId ?? `retention-${now.toISOString()}`;
	const evidence = retentionCutoff(settings, "evidence", now);
	const snapshot = retentionCutoff(settings, "snapshot", now);
	const audit = retentionCutoff(settings, "audit", now);
	return {
		evidence: evidence ? await purgeEvidence(db, organizationId, evidence, deps, requestId) : emptyResult(null),
		snapshot: snapshot ? await purgeSnapshots(db, organizationId, snapshot, deps, requestId) : emptyResult(null),
		audit: audit ? await purgeAudit(db, organizationId, audit, deps, requestId) : emptyResult(null),
	};
}

export interface GeoRetentionPreview {
	category: GeoRetentionCategory;
	cutoff: string | null;
	rows: number;
}

/** Roughly what the next purge would remove under these settings, for the approval screen. */
export async function previewGeoRetention(
	db: DbConnection,
	organizationId: string,
	settings: GeoRetentionSettings,
	now: Date = new Date(),
): Promise<GeoRetentionPreview[]> {
	const evidence = retentionCutoff(settings, "evidence", now);
	const snapshot = retentionCutoff(settings, "snapshot", now);
	const audit = retentionCutoff(settings, "audit", now);

	const count = async (query: ReturnType<typeof sql>): Promise<number> => {
		const result = await db.execute(query);
		return Number((result.rows[0] as { count: string | number } | undefined)?.count ?? 0);
	};

	return [
		{
			category: "evidence",
			cutoff: evidence?.toISOString() ?? null,
			rows: evidence
				? await count(sql`select count(*) as count from geo_observations
						where organization_id = ${organizationId} and sampled_at < ${evidence}`)
				: 0,
		},
		{
			category: "snapshot",
			cutoff: snapshot?.toISOString() ?? null,
			rows: snapshot
				? await count(sql`select count(*) as count from geo_site_page_versions v
						where v.organization_id = ${organizationId} and v.fetched_at < ${snapshot}
							and exists (select 1 from geo_site_page_versions n where n.page_id = v.page_id and n.fetched_at > v.fetched_at)
							and not exists (select 1 from geo_assertion_sources s where s.page_version_id = v.id)
							and not exists (select 1 from geo_site_entity_sources e where e.page_version_id = v.id)
							and not exists (select 1 from geo_site_audit_findings f where f.page_version_id = v.id)`)
				: 0,
		},
		{
			category: "audit",
			cutoff: audit?.toISOString() ?? null,
			rows: audit
				? await count(sql`select count(*) as count from geo_audit_logs
						where organization_id = ${organizationId} and created_at < ${audit}`)
				: 0,
		},
	];
}
