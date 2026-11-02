import {
	GeoError,
	type GeoPrincipal,
	type GeoRiskLevel,
	type GeoSiteEntityKind,
	geoSystemPrincipal,
} from "@workspace/geo-domain";
import type { DbConnection } from "@workspace/lib/db/db-connection";
import {
	geoAssertionSources,
	geoKnowledgeAssertions,
	geoSiteEntities,
	geoSiteEntitySources,
	geoSitePages,
	geoSitePageVersions,
	geoSiteSources,
} from "@workspace/lib/db/schema";
import { writeGeoAudit } from "@workspace/lib/geo/audit";
import { detectAssertionConflicts } from "@workspace/lib/geo/knowledge";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { AssertionCandidate, EntityCandidate, FieldLocator } from "../contracts";
import { siteContentNormalizer, siteKnowledgeMapper } from "../knowledge";
import { searchTokensOf } from "../text";
import type { SiteJobDeps } from "./deps";
import { loadParsedPage } from "./parse";
import { loadProfileVersion, profileOfSource } from "./sources";

/**
 * Where a value came from, exact enough for a reviewer to open the snapshot of
 * that page version and find the element: page version, field path, selector,
 * position and a quote of the matched text.
 */
export interface SiteFieldLocator {
	pageVersionId: string;
	pageId: string;
	url: string;
	parserVersion: string;
	fieldPath: string;
	selector: string | null;
	ordinal: number | null;
	quote: string | null;
}

export interface SiteCandidate {
	entity: EntityCandidate;
	assertions: AssertionCandidate[];
}

export interface UpsertSiteCandidatesResult {
	pageVersionId: string;
	entities: Array<{ id: string; kind: GeoSiteEntityKind; canonicalKey: string; created: boolean }>;
	/**
	 * `created: false` means an assertion with the same entity, field and value
	 * already existed (in any status) and only gained this page version as a source.
	 */
	assertions: Array<{
		id: string;
		entityId: string;
		fieldPath: string;
		claimType: string;
		riskLevel: GeoRiskLevel;
		created: boolean;
	}>;
}

function locatorOf(
	version: { id: string; pageId: string; parserVersion: string },
	url: string,
	fieldPath: string,
	locator: FieldLocator | null,
): SiteFieldLocator {
	return {
		pageVersionId: version.id,
		pageId: version.pageId,
		url,
		parserVersion: version.parserVersion,
		fieldPath,
		selector: locator?.selector ?? null,
		ordinal: locator?.ordinal ?? null,
		quote: locator?.quote ?? null,
	};
}

async function upsertEntity(
	tx: DbConnection,
	organizationId: string,
	entity: EntityCandidate,
): Promise<{ id: string; created: boolean }> {
	const [inserted] = await tx
		.insert(geoSiteEntities)
		.values({
			organizationId,
			kind: entity.kind,
			canonicalKey: entity.canonicalKey,
			title: entity.title,
			attributes: entity.attributes,
			status: "CANDIDATE",
		})
		.onConflictDoNothing()
		.returning({ id: geoSiteEntities.id });
	if (inserted) return { id: inserted.id, created: true };
	const sameEntity = and(
		eq(geoSiteEntities.organizationId, organizationId),
		eq(geoSiteEntities.kind, entity.kind),
		eq(geoSiteEntities.canonicalKey, entity.canonicalKey),
	);
	const [refreshed] = await tx
		.update(geoSiteEntities)
		.set({ title: entity.title, attributes: entity.attributes, status: "CANDIDATE" })
		.where(and(sameEntity, inArray(geoSiteEntities.status, ["CANDIDATE", "SOURCE_UNAVAILABLE"])))
		.returning({ id: geoSiteEntities.id });
	if (refreshed) return { id: refreshed.id, created: false };
	const [kept] = await tx.select({ id: geoSiteEntities.id }).from(geoSiteEntities).where(sameEntity).limit(1);
	return { id: kept.id, created: false };
}

async function upsertAssertion(
	tx: DbConnection,
	input: {
		organizationId: string;
		entityId: string;
		entity: EntityCandidate;
		assertion: AssertionCandidate;
		version: { id: string; pageId: string; parserVersion: string; url: string };
	},
): Promise<UpsertSiteCandidatesResult["assertions"][number]> {
	const { organizationId, entityId, entity, assertion, version } = input;
	const normalized = JSON.stringify(assertion.normalizedValue ?? null);
	const [same] = await tx
		.select({ id: geoKnowledgeAssertions.id, riskLevel: geoKnowledgeAssertions.riskLevel })
		.from(geoKnowledgeAssertions)
		.where(
			and(
				eq(geoKnowledgeAssertions.organizationId, organizationId),
				eq(geoKnowledgeAssertions.entityId, entityId),
				eq(geoKnowledgeAssertions.fieldPath, assertion.fieldPath),
				eq(geoKnowledgeAssertions.claimType, assertion.claimType),
				sql`${geoKnowledgeAssertions.normalizedValue} = ${normalized}::jsonb`,
			),
		)
		.limit(1);
	let assertionId = same?.id;
	if (!assertionId) {
		const [created] = await tx
			.insert(geoKnowledgeAssertions)
			.values({
				organizationId,
				entityId,
				claimType: assertion.claimType,
				fieldPath: assertion.fieldPath,
				claimText: assertion.claimText,
				normalizedValue: assertion.normalizedValue ?? null,
				riskLevel: assertion.riskLevel,
				status: "PENDING_REVIEW",
				publicationScope: "INTERNAL",
				searchTokens: searchTokensOf(`${entity.title} ${assertion.claimText}`),
				authorId: null,
			})
			.returning({ id: geoKnowledgeAssertions.id });
		assertionId = created.id;
	}
	const [linked] = await tx
		.select({ id: geoAssertionSources.id })
		.from(geoAssertionSources)
		.where(and(eq(geoAssertionSources.assertionId, assertionId), eq(geoAssertionSources.pageVersionId, version.id)))
		.limit(1);
	if (!linked) {
		await tx.insert(geoAssertionSources).values({
			organizationId,
			assertionId,
			sourceKind: "PAGE_VERSION",
			pageVersionId: version.id,
			locator: locatorOf(version, version.url, assertion.fieldPath, assertion.locator),
			parserVersion: version.parserVersion,
			extractedAt: sql`now()`,
		});
	}
	return {
		id: assertionId,
		entityId,
		fieldPath: assertion.fieldPath,
		claimType: assertion.claimType,
		riskLevel: same?.riskLevel ?? assertion.riskLevel,
		created: !same,
	};
}

/**
 * Writes what a crawl found as reviewable candidates and nothing more. Entities
 * already confirmed or rejected keep their data; an assertion whose value
 * already exists only gains a source; a new value becomes a new PENDING_REVIEW
 * assertion beside the old one, so an approved fact is never overwritten and
 * conflict detection can compare the two.
 */
export async function upsertSiteCandidates(
	tx: DbConnection,
	principal: GeoPrincipal,
	input: { pageVersionId: string; candidates: SiteCandidate[] },
): Promise<UpsertSiteCandidatesResult> {
	const { organizationId } = principal;
	const [version] = await tx
		.select({
			id: geoSitePageVersions.id,
			pageId: geoSitePageVersions.pageId,
			parserVersion: geoSitePageVersions.parserVersion,
			url: geoSitePages.normalizedUrl,
		})
		.from(geoSitePageVersions)
		.innerJoin(geoSitePages, eq(geoSitePages.id, geoSitePageVersions.pageId))
		.where(and(eq(geoSitePageVersions.organizationId, organizationId), eq(geoSitePageVersions.id, input.pageVersionId)))
		.limit(1);
	if (!version) throw new GeoError("NOT_FOUND", "页面版本不存在");

	const result: UpsertSiteCandidatesResult = { pageVersionId: version.id, entities: [], assertions: [] };
	for (const { entity, assertions } of input.candidates) {
		const { id: entityId, created } = await upsertEntity(tx, organizationId, entity);
		result.entities.push({ id: entityId, kind: entity.kind, canonicalKey: entity.canonicalKey, created });
		const sourceRows = [
			{ fieldPath: "title", locator: locatorOf(version, version.url, "title", null) },
			...entity.fields.map((field) => ({
				fieldPath: field.path,
				locator: locatorOf(version, version.url, field.path, field.locator),
			})),
		];
		await tx
			.insert(geoSiteEntitySources)
			.values(
				sourceRows.map((row) => ({
					organizationId,
					entityId,
					pageVersionId: version.id,
					fieldPath: row.fieldPath,
					locator: row.locator,
				})),
			)
			.onConflictDoNothing();
		for (const assertion of assertions) {
			result.assertions.push(await upsertAssertion(tx, { organizationId, entityId, entity, assertion, version }));
		}
	}

	await writeGeoAudit(tx, {
		principal,
		action: "site.normalize",
		entityType: "site_page_version",
		entityId: version.id,
		metadata: {
			entities: result.entities.length,
			newAssertions: result.assertions.filter((assertion) => assertion.created).length,
			linkedAssertions: result.assertions.filter((assertion) => !assertion.created).length,
			highRisk: result.assertions.filter((assertion) => assertion.riskLevel === "HIGH").length,
		},
	});
	return result;
}

function profileVersionFromParser(parserVersion: string): number | null {
	const match = /@(\d+)$/.exec(parserVersion);
	return match ? Number(match[1]) : null;
}

/** normalize.site-entity: parsed page → entities → PENDING_REVIEW assertions. */
export async function normalizeSiteVersion(
	deps: SiteJobDeps,
	input: { organizationId: string; versionId: string },
): Promise<UpsertSiteCandidatesResult | null> {
	const [row] = await deps.db
		.select({ version: geoSitePageVersions, sourceId: geoSitePages.siteSourceId })
		.from(geoSitePageVersions)
		.innerJoin(geoSitePages, eq(geoSitePages.id, geoSitePageVersions.pageId))
		.where(
			and(eq(geoSitePageVersions.organizationId, input.organizationId), eq(geoSitePageVersions.id, input.versionId)),
		)
		.limit(1);
	if (!row || row.version.parseStatus !== "PARSED") return null;
	const parsed = await loadParsedPage(deps, row.version);
	const profileVersion = profileVersionFromParser(row.version.parserVersion);
	const profile = profileVersion
		? await loadProfileVersion(deps.db, input.organizationId, row.sourceId, profileVersion).catch(() => null)
		: null;
	const [source] = profile
		? []
		: await deps.db.select().from(geoSiteSources).where(eq(geoSiteSources.id, row.sourceId)).limit(1);
	const effectiveProfile = profile ?? profileOfSource(source ?? { profile: {} });
	const entities = parsed ? siteContentNormalizer.normalize(parsed) : [];
	const candidates = entities.map((entity) => ({
		entity,
		assertions: siteKnowledgeMapper.map(entity, effectiveProfile),
	}));
	const principal = geoSystemPrincipal(input.organizationId, "site-normalize", `normalize-${row.version.id}`);
	return deps.db.transaction(async (tx) => {
		// Assertions are matched by value before insert, with no unique key to fall back on.
		await tx.execute(
			sql`select pg_advisory_xact_lock(hashtextextended(${`geo-site-normalize:${input.organizationId}`}, 0))`,
		);
		const result = await upsertSiteCandidates(tx, principal, { pageVersionId: row.version.id, candidates });
		await detectAssertionConflicts(tx, principal, {
			assertionIds: result.assertions.filter((assertion) => assertion.created).map((assertion) => assertion.id),
		});
		return result;
	});
}
