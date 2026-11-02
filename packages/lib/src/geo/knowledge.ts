import {
	assertionTransition,
	detectConflictPairs,
	effectiveRiskLevel,
	GEO_CONFLICT_CANDIDATE_STATUSES,
	type GeoConflictCandidate,
	type GeoConflictResolution,
	type GeoFactState,
	type GeoKnowledgeSourceFacts,
	type GeoPrincipal,
	type GeoRiskLevel,
	geoSystemPrincipal,
	hasValidOriginalDocument,
	isLiveSource,
} from "@workspace/geo-domain";
import { and, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import type { DbConnection } from "../db/db-connection";
import {
	geoAssertionConflicts,
	geoAssertionSources,
	geoKnowledgeAssertions,
	geoKnowledgeAssets,
	geoSitePages,
	geoSitePageVersions,
} from "../db/schema-geo";
import { writeGeoAudit } from "./audit";

export interface GeoAssertionSourceRow extends GeoKnowledgeSourceFacts {
	id: string;
	assertionId: string;
	pageVersionId: string | null;
	pageId: string | null;
	url: string | null;
	assetId: string | null;
	assetTitle: string | null;
	assetConfidentiality: string | null;
	locator: unknown;
	parserVersion: string | null;
	extractedAt: Date;
}

export async function loadAssertionSources(
	db: DbConnection,
	organizationId: string,
	assertionIds: readonly string[],
): Promise<Map<string, GeoAssertionSourceRow[]>> {
	const result = new Map<string, GeoAssertionSourceRow[]>();
	if (assertionIds.length === 0) return result;
	const rows = await db
		.select({
			id: geoAssertionSources.id,
			assertionId: geoAssertionSources.assertionId,
			kind: geoAssertionSources.sourceKind,
			pageVersionId: geoAssertionSources.pageVersionId,
			pageId: geoSitePages.id,
			url: geoSitePages.normalizedUrl,
			pageStatus: geoSitePages.status,
			assetId: geoAssertionSources.assetId,
			assetTitle: geoKnowledgeAssets.title,
			assetApproval: geoKnowledgeAssets.approvalStatus,
			assetScan: geoKnowledgeAssets.scanStatus,
			assetValidUntil: geoKnowledgeAssets.validUntil,
			assetPublicationScope: geoKnowledgeAssets.publicationScope,
			assetConfidentiality: geoKnowledgeAssets.confidentiality,
			locator: geoAssertionSources.locator,
			parserVersion: geoAssertionSources.parserVersion,
			extractedAt: geoAssertionSources.extractedAt,
		})
		.from(geoAssertionSources)
		.leftJoin(geoSitePageVersions, eq(geoSitePageVersions.id, geoAssertionSources.pageVersionId))
		.leftJoin(geoSitePages, eq(geoSitePages.id, geoSitePageVersions.pageId))
		.leftJoin(geoKnowledgeAssets, eq(geoKnowledgeAssets.id, geoAssertionSources.assetId))
		.where(
			and(
				eq(geoAssertionSources.organizationId, organizationId),
				inArray(geoAssertionSources.assertionId, [...assertionIds]),
			),
		)
		.orderBy(geoAssertionSources.extractedAt);
	for (const row of rows) {
		const list = result.get(row.assertionId) ?? [];
		list.push(row);
		result.set(row.assertionId, list);
	}
	return result;
}

/** What a draft or an export needs to know about each fact right now. */
export async function loadFactStates(
	db: DbConnection,
	organizationId: string,
	assertionIds: readonly string[],
): Promise<Map<string, GeoFactState>> {
	const states = new Map<string, GeoFactState>();
	if (assertionIds.length === 0) return states;
	const ids = [...new Set(assertionIds)];
	const rows = await db
		.select({
			id: geoKnowledgeAssertions.id,
			status: geoKnowledgeAssertions.status,
			publicationScope: geoKnowledgeAssertions.publicationScope,
			validUntil: geoKnowledgeAssertions.validUntil,
			frozenAt: geoKnowledgeAssertions.frozenAt,
			openConflicts: sql<number>`(
				select count(*)::int from ${geoAssertionConflicts}
				where ${geoAssertionConflicts.status} = 'OPEN'
				and (${geoAssertionConflicts.approvedId} = ${geoKnowledgeAssertions.id}
					or ${geoAssertionConflicts.candidateId} = ${geoKnowledgeAssertions.id})
			)`,
		})
		.from(geoKnowledgeAssertions)
		.where(and(eq(geoKnowledgeAssertions.organizationId, organizationId), inArray(geoKnowledgeAssertions.id, ids)));
	for (const row of rows) {
		states.set(row.id, {
			status: row.status,
			publicationScope: row.publicationScope,
			validUntil: row.validUntil,
			frozen: row.frozenAt !== null,
			openConflicts: Number(row.openConflicts),
		});
	}
	return states;
}

/**
 * Opens a conflict for every new value that disagrees with an approved fact of
 * the same entity and field. A pair that was already settled is not reopened,
 * and neither side is modified. With `assertionIds`, only their fields are checked.
 */
export async function detectAssertionConflicts(
	db: DbConnection,
	principal: Pick<GeoPrincipal, "organizationId" | "actorId" | "actorKind" | "requestId">,
	options: { assertionIds?: readonly string[] } = {},
): Promise<{ id: string; candidateId: string; approvedId: string }[]> {
	const { organizationId } = principal;
	if (options.assertionIds && options.assertionIds.length === 0) return [];
	const keyed = and(
		eq(geoKnowledgeAssertions.organizationId, organizationId),
		isNotNull(geoKnowledgeAssertions.entityId),
		isNotNull(geoKnowledgeAssertions.fieldPath),
	);
	const scopedKeys = options.assertionIds
		? sql`(${geoKnowledgeAssertions.entityId}, ${geoKnowledgeAssertions.fieldPath}, ${geoKnowledgeAssertions.claimType}) in (
				select entity_id, field_path, claim_type from geo_knowledge_assertions
				where organization_id = ${organizationId}
				and id in (${sql.join(
					options.assertionIds.map((id) => sql`${id}::uuid`),
					sql`, `,
				)})
			)`
		: sql`(${geoKnowledgeAssertions.entityId}, ${geoKnowledgeAssertions.fieldPath}, ${geoKnowledgeAssertions.claimType}) in (
				select entity_id, field_path, claim_type from geo_knowledge_assertions
				where organization_id = ${organizationId} and status = 'APPROVED'
			)`;
	const rows: GeoConflictCandidate[] = await db
		.select({
			id: geoKnowledgeAssertions.id,
			entityId: geoKnowledgeAssertions.entityId,
			fieldPath: geoKnowledgeAssertions.fieldPath,
			claimType: geoKnowledgeAssertions.claimType,
			claimText: geoKnowledgeAssertions.claimText,
			normalizedValue: geoKnowledgeAssertions.normalizedValue,
			status: geoKnowledgeAssertions.status,
		})
		.from(geoKnowledgeAssertions)
		.where(
			and(keyed, inArray(geoKnowledgeAssertions.status, ["APPROVED", ...GEO_CONFLICT_CANDIDATE_STATUSES]), scopedKeys),
		);
	const pairs = detectConflictPairs(rows);
	if (pairs.length === 0) return [];

	const known = await db
		.select({ candidateId: geoAssertionConflicts.candidateId, approvedId: geoAssertionConflicts.approvedId })
		.from(geoAssertionConflicts)
		.where(
			and(
				eq(geoAssertionConflicts.organizationId, organizationId),
				inArray(geoAssertionConflicts.candidateId, [...new Set(pairs.map((pair) => pair.candidateId))]),
			),
		);
	const seen = new Set(known.map((pair) => `${pair.candidateId}:${pair.approvedId}`));
	const fresh = pairs.filter((pair) => !seen.has(`${pair.candidateId}:${pair.approvedId}`));
	if (fresh.length === 0) return [];

	const created = await db
		.insert(geoAssertionConflicts)
		.values(fresh.map((pair) => ({ organizationId, ...pair, status: "OPEN" as const })))
		.onConflictDoNothing()
		.returning({
			id: geoAssertionConflicts.id,
			candidateId: geoAssertionConflicts.candidateId,
			approvedId: geoAssertionConflicts.approvedId,
		});
	for (const conflict of created) {
		await writeGeoAudit(db, {
			principal,
			action: "knowledge.conflict.open",
			entityType: "assertion_conflict",
			entityId: conflict.id,
			after: conflict,
		});
	}
	return created;
}

/** Settles the open conflicts an assertion is part of, on either side. */
export async function closeAssertionConflicts(
	db: DbConnection,
	principal: Pick<GeoPrincipal, "organizationId" | "actorId" | "actorKind" | "requestId">,
	input: { assertionId: string; resolution: GeoConflictResolution; note?: string | null },
): Promise<number> {
	const closed = await db
		.update(geoAssertionConflicts)
		.set({
			status: "RESOLVED",
			resolution: input.note ? `${input.resolution}: ${input.note}` : input.resolution,
			resolvedBy: principal.actorId,
			resolvedAt: new Date(),
		})
		.where(
			and(
				eq(geoAssertionConflicts.organizationId, principal.organizationId),
				eq(geoAssertionConflicts.status, "OPEN"),
				or(
					eq(geoAssertionConflicts.candidateId, input.assertionId),
					eq(geoAssertionConflicts.approvedId, input.assertionId),
				),
			),
		)
		.returning({ id: geoAssertionConflicts.id });
	for (const conflict of closed) {
		await writeGeoAudit(db, {
			principal,
			action: "knowledge.conflict.resolve",
			entityType: "assertion_conflict",
			entityId: conflict.id,
			metadata: { resolution: input.resolution, assertionId: input.assertionId },
		});
	}
	return closed.length;
}

type ValidityReason = "EXPIRED" | "SOURCE_UNAVAILABLE" | "ORIGINAL_UNAVAILABLE";

function validityProblem(
	assertion: { riskLevel: GeoRiskLevel; claimType: string; validUntil: Date | null },
	sources: readonly GeoKnowledgeSourceFacts[],
	now: Date,
): ValidityReason | null {
	if (assertion.validUntil && assertion.validUntil.getTime() <= now.getTime()) return "EXPIRED";
	if (!sources.some((source) => isLiveSource(source, now))) return "SOURCE_UNAVAILABLE";
	if (effectiveRiskLevel(assertion) === "HIGH" && !hasValidOriginalDocument(sources, now)) {
		return "ORIGINAL_UNAVAILABLE";
	}
	return null;
}

/**
 * Approved facts that lapsed, lost every live source, or (high risk) lost the
 * customer original behind them stop being publishable and go back for review.
 * The fact and its history stay; only the status moves.
 */
export async function sweepKnowledgeValidity(
	db: DbConnection,
	organizationId: string,
	now: Date = new Date(),
): Promise<Record<ValidityReason, number>> {
	const counts: Record<ValidityReason, number> = { EXPIRED: 0, SOURCE_UNAVAILABLE: 0, ORIGINAL_UNAVAILABLE: 0 };
	const principal = geoSystemPrincipal(organizationId, "knowledge-validity", `knowledge-validity-${now.getTime()}`);
	const approved = await db
		.select({
			id: geoKnowledgeAssertions.id,
			status: geoKnowledgeAssertions.status,
			riskLevel: geoKnowledgeAssertions.riskLevel,
			claimType: geoKnowledgeAssertions.claimType,
			validUntil: geoKnowledgeAssertions.validUntil,
		})
		.from(geoKnowledgeAssertions)
		.where(
			and(eq(geoKnowledgeAssertions.organizationId, organizationId), eq(geoKnowledgeAssertions.status, "APPROVED")),
		);
	if (approved.length === 0) return counts;
	const sources = await loadAssertionSources(
		db,
		organizationId,
		approved.map((row) => row.id),
	);

	for (const assertion of approved) {
		const reason = validityProblem(assertion, sources.get(assertion.id) ?? [], now);
		if (!reason) continue;
		const result = assertionTransition({
			assertion: { status: assertion.status, riskLevel: assertion.riskLevel, authorId: null },
			action: "MARK_SOURCE_UNAVAILABLE",
			actor: { kind: "system" },
			now,
		});
		if (!result.ok) continue;
		const moved = await db
			.update(geoKnowledgeAssertions)
			.set({ status: result.to })
			.where(and(eq(geoKnowledgeAssertions.id, assertion.id), eq(geoKnowledgeAssertions.status, "APPROVED")))
			.returning({ id: geoKnowledgeAssertions.id });
		if (moved.length === 0) continue;
		await writeGeoAudit(db, {
			principal,
			action: "knowledge.assertion.unavailable",
			entityType: "knowledge_assertion",
			entityId: assertion.id,
			before: { status: "APPROVED" },
			after: { status: result.to },
			metadata: { reason },
		});
		await closeAssertionConflicts(db, principal, { assertionId: assertion.id, resolution: "SUPERSEDED" });
		counts[reason] += 1;
	}
	return counts;
}

/** Organizations with approved facts to watch or new values to compare. */
export async function knowledgeOrganizationIds(db: DbConnection): Promise<string[]> {
	const rows = await db
		.selectDistinct({ organizationId: geoKnowledgeAssertions.organizationId })
		.from(geoKnowledgeAssertions)
		.where(inArray(geoKnowledgeAssertions.status, ["APPROVED", ...GEO_CONFLICT_CANDIDATE_STATUSES]));
	return rows.map((row) => row.organizationId);
}
