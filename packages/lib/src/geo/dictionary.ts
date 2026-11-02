import {
	diffDictionarySnapshots,
	type GeoDictionaryEntityChange,
	type GeoDictionarySnapshot,
	type GeoPrincipal,
} from "@workspace/geo-domain";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { DbConnection } from "../db/db-connection";
import { geoBrandEntities, geoDictionaryVersions, geoProducts } from "../db/schema-geo";

export type GeoDictionaryVersion = typeof geoDictionaryVersions.$inferSelect;

/**
 * Hold this before reading other entities to check for conflicts: the check, the write
 * and the next version number have to be one step, or two concurrent saves could both
 * pass the check and both claim the same version.
 */
export async function lockGeoDictionary(tx: DbConnection, organizationId: string): Promise<void> {
	await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`geo-dictionary:${organizationId}`}, 0))`);
}

export async function buildDictionarySnapshot(
	tx: DbConnection,
	organizationId: string,
): Promise<GeoDictionarySnapshot> {
	const entities = await tx
		.select({
			id: geoBrandEntities.id,
			kind: geoBrandEntities.kind,
			displayName: geoBrandEntities.displayName,
			legalName: geoBrandEntities.legalName,
			shortName: geoBrandEntities.shortName,
			aliases: geoBrandEntities.aliases,
			historicalNames: geoBrandEntities.historicalNames,
			domains: geoBrandEntities.domains,
			officialUrl: geoBrandEntities.officialUrl,
			regions: geoBrandEntities.regions,
			status: geoBrandEntities.status,
			factStatus: geoBrandEntities.factStatus,
		})
		.from(geoBrandEntities)
		.where(eq(geoBrandEntities.organizationId, organizationId))
		.orderBy(asc(geoBrandEntities.createdAt), asc(geoBrandEntities.id));
	const products = await tx
		.select({
			id: geoProducts.id,
			brandEntityId: geoProducts.brandEntityId,
			model: geoProducts.model,
			name: geoProducts.name,
			category: geoProducts.category,
			termKind: geoProducts.termKind,
			factStatus: geoProducts.factStatus,
			status: geoProducts.status,
		})
		.from(geoProducts)
		.where(eq(geoProducts.organizationId, organizationId))
		.orderBy(asc(geoProducts.createdAt), asc(geoProducts.id));
	return { entities, products };
}

/** Call inside the transaction doing the write, after `lockGeoDictionary`. */
export async function appendDictionaryVersion(
	tx: DbConnection,
	principal: Pick<GeoPrincipal, "organizationId" | "actorId">,
	changeNote: string,
): Promise<GeoDictionaryVersion> {
	const { organizationId, actorId } = principal;
	const [latest] = await tx
		.select({ version: geoDictionaryVersions.version, snapshot: geoDictionaryVersions.snapshot })
		.from(geoDictionaryVersions)
		.where(eq(geoDictionaryVersions.organizationId, organizationId))
		.orderBy(desc(geoDictionaryVersions.version))
		.limit(1);
	const snapshot = await buildDictionarySnapshot(tx, organizationId);
	const changes: GeoDictionaryEntityChange[] = diffDictionarySnapshots(latest?.snapshot ?? null, snapshot);

	const [row] = await tx
		.insert(geoDictionaryVersions)
		.values({
			organizationId,
			version: (latest?.version ?? 0) + 1,
			snapshot,
			changes,
			changedEntityIds: changes.map((change) => change.entityId),
			changeNote,
			createdBy: actorId,
		})
		.returning();
	if (!row) throw new Error("Dictionary version insert returned no row");
	return row;
}

/** Null until the organization has defined its first brand. */
export async function getCurrentDictionary(
	db: DbConnection,
	organizationId: string,
): Promise<GeoDictionaryVersion | null> {
	const [row] = await db
		.select()
		.from(geoDictionaryVersions)
		.where(eq(geoDictionaryVersions.organizationId, organizationId))
		.orderBy(desc(geoDictionaryVersions.version))
		.limit(1);
	return row ?? null;
}

export async function getDictionaryVersion(
	db: DbConnection,
	organizationId: string,
	ref: { id: string } | { version: number },
): Promise<GeoDictionaryVersion | null> {
	const [row] = await db
		.select()
		.from(geoDictionaryVersions)
		.where(
			and(
				eq(geoDictionaryVersions.organizationId, organizationId),
				"id" in ref ? eq(geoDictionaryVersions.id, ref.id) : eq(geoDictionaryVersions.version, ref.version),
			),
		)
		.limit(1);
	return row ?? null;
}
