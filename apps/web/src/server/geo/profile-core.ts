import {
	assertGeoPermission,
	dedupeBrandTerms,
	describeBrandConflicts,
	findBrandConflicts,
	GEO_ACTIVE_STATUSES,
	GEO_BRAND_KINDS,
	GEO_FACT_STATUSES,
	GEO_TERM_KINDS,
	type GeoActiveStatus,
	type GeoDictionaryEntityChange,
	GeoError,
	type GeoPrincipal,
	normalizeBrandDomain,
	normalizeBrandTerm,
	productTermProblem,
} from "@workspace/geo-domain";
import { db } from "@workspace/lib/db/db";
import type { DbConnection } from "@workspace/lib/db/db-connection";
import { geoBrandEntities, geoDictionaryVersions, geoProducts } from "@workspace/lib/db/schema";
import { writeGeoAudit } from "@workspace/lib/geo/audit";
import { appendDictionaryVersion, lockGeoDictionary } from "@workspace/lib/geo/dictionary";
import { and, asc, count, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";

export type GeoBrandEntity = typeof geoBrandEntities.$inferSelect;
export type GeoProduct = typeof geoProducts.$inferSelect;

const term = z.string().trim().min(1).max(200);
const nullableText = (max: number) =>
	z
		.string()
		.trim()
		.max(max)
		.nullish()
		.transform((value) => value || null);

export const brandInputSchema = z.object({
	kind: z.enum(GEO_BRAND_KINDS),
	displayName: term,
	legalName: nullableText(200),
	shortName: nullableText(100),
	aliases: z.array(term).max(100).default([]),
	historicalNames: z.array(term).max(50).default([]),
	domains: z.array(z.string().trim().min(1).max(253)).max(20).default([]),
	officialUrl: z
		.url({ protocol: /^https?$/ })
		.max(2048)
		.nullish()
		.transform((value) => value || null),
	regions: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
	factStatus: z.enum(GEO_FACT_STATUSES).optional(),
	factNotes: z.array(z.string().trim().min(1).max(500)).max(50).optional(),
	changeNote: nullableText(500),
});
export type GeoBrandInput = z.input<typeof brandInputSchema>;

export const brandPatchSchema = brandInputSchema
	.omit({ kind: true })
	.partial()
	.extend({ status: z.enum(GEO_ACTIVE_STATUSES).optional() });
export type GeoBrandPatch = z.input<typeof brandPatchSchema>;

export const productInputSchema = z.object({
	name: term,
	model: nullableText(100),
	category: nullableText(100),
	termKind: z.enum(GEO_TERM_KINDS),
	factStatus: z.enum(GEO_FACT_STATUSES).optional(),
	changeNote: nullableText(500),
});
export type GeoProductInput = z.input<typeof productInputSchema>;

export const productPatchSchema = productInputSchema
	.partial()
	.extend({ status: z.enum(GEO_ACTIVE_STATUSES).optional() });
export type GeoProductPatch = z.input<typeof productPatchSchema>;

export interface GeoBrandWithProducts extends GeoBrandEntity {
	products: GeoProduct[];
}

function normalizeDomains(domains: readonly string[]): string[] {
	const normalized: string[] = [];
	for (const domain of domains) {
		const host = normalizeBrandDomain(domain);
		if (!host) throw new GeoError("VALIDATION_ERROR", `域名格式无效：${domain}`);
		if (!normalized.includes(host)) normalized.push(host);
	}
	return normalized;
}

type BrandTerms = Pick<
	GeoBrandEntity,
	"displayName" | "legalName" | "shortName" | "aliases" | "historicalNames" | "domains"
>;

/** A name repeated as its own alias, or twice in different case or width, is stored once. */
function cleanTerms(input: BrandTerms): BrandTerms {
	const ownNames = [input.displayName, input.legalName, input.shortName];
	const aliases = dedupeBrandTerms(input.aliases, ownNames);
	return {
		...input,
		aliases,
		historicalNames: dedupeBrandTerms(input.historicalNames, [...ownNames, ...aliases]),
		domains: normalizeDomains(input.domains),
	};
}

async function assertNoConflicts(tx: DbConnection, organizationId: string, candidate: BrandTerms & { id?: string }) {
	const others = await tx
		.select({
			id: geoBrandEntities.id,
			status: geoBrandEntities.status,
			displayName: geoBrandEntities.displayName,
			legalName: geoBrandEntities.legalName,
			shortName: geoBrandEntities.shortName,
			aliases: geoBrandEntities.aliases,
			historicalNames: geoBrandEntities.historicalNames,
			domains: geoBrandEntities.domains,
		})
		.from(geoBrandEntities)
		.where(eq(geoBrandEntities.organizationId, organizationId));
	const conflicts = findBrandConflicts(candidate, others);
	if (conflicts.length > 0) throw new GeoError("CONFLICT", describeBrandConflicts(conflicts));
}

async function loadBrand(tx: DbConnection, organizationId: string, id: string, lock = false): Promise<GeoBrandEntity> {
	const query = tx
		.select()
		.from(geoBrandEntities)
		.where(and(eq(geoBrandEntities.organizationId, organizationId), eq(geoBrandEntities.id, id)))
		.limit(1);
	const [row] = lock ? await query.for("update") : await query;
	if (!row) throw new GeoError("NOT_FOUND", "品牌或竞品不存在");
	return row;
}

type StatusChange = "update" | "disable" | "enable";
const CHANGE_VERBS: Record<StatusChange, string> = { update: "修改", disable: "停用", enable: "启用" };

function statusChange(before: GeoActiveStatus, after: GeoActiveStatus): StatusChange {
	if (before === after) return "update";
	return after === "DISABLED" ? "disable" : "enable";
}

function sameValues<T extends object>(next: T, before: T): boolean {
	return (Object.keys(next) as (keyof T)[]).every((key) => JSON.stringify(next[key]) === JSON.stringify(before[key]));
}

/** An omitted field keeps its value; an explicit null clears it. */
function keep<T>(value: T | undefined, current: T): T {
	return value === undefined ? current : value;
}

function mergeBrandPatch(before: GeoBrandEntity, patch: z.output<typeof brandPatchSchema>) {
	const terms = cleanTerms({
		displayName: keep(patch.displayName, before.displayName),
		legalName: keep(patch.legalName, before.legalName),
		shortName: keep(patch.shortName, before.shortName),
		aliases: keep(patch.aliases, before.aliases),
		historicalNames: keep(patch.historicalNames, before.historicalNames),
		domains: keep(patch.domains, before.domains),
	});
	return {
		...terms,
		officialUrl: keep(patch.officialUrl, before.officialUrl),
		regions: patch.regions ? dedupeBrandTerms(patch.regions) : before.regions,
		status: keep(patch.status, before.status),
		factStatus: keep(patch.factStatus, before.factStatus),
		factNotes: keep(patch.factNotes, before.factNotes),
	};
}

function mergeProductPatch(before: GeoProduct, patch: z.output<typeof productPatchSchema>) {
	return {
		name: keep(patch.name, before.name),
		model: keep(patch.model, before.model),
		category: keep(patch.category, before.category),
		termKind: keep(patch.termKind, before.termKind),
		factStatus: keep(patch.factStatus, before.factStatus),
		status: keep(patch.status, before.status),
	};
}

export async function listBrands(
	principal: GeoPrincipal,
	filters: { kind?: GeoBrandEntity["kind"]; status?: GeoActiveStatus } = {},
): Promise<GeoBrandWithProducts[]> {
	assertGeoPermission(principal, "brand.read");
	const conditions = [eq(geoBrandEntities.organizationId, principal.organizationId)];
	if (filters.kind) conditions.push(eq(geoBrandEntities.kind, filters.kind));
	if (filters.status) conditions.push(eq(geoBrandEntities.status, filters.status));

	const [brands, products] = await Promise.all([
		db
			.select()
			.from(geoBrandEntities)
			.where(and(...conditions))
			.orderBy(asc(geoBrandEntities.kind), asc(geoBrandEntities.createdAt)),
		db
			.select()
			.from(geoProducts)
			.where(eq(geoProducts.organizationId, principal.organizationId))
			.orderBy(asc(geoProducts.createdAt)),
	]);
	return brands.map((brand) => ({
		...brand,
		products: products.filter((product) => product.brandEntityId === brand.id),
	}));
}

export interface GeoAliasHistoryEntry extends GeoDictionaryEntityChange {
	version: number;
	createdAt: Date;
	createdBy: string;
	changeNote: string | null;
}

export async function getBrand(
	principal: GeoPrincipal,
	id: string,
): Promise<GeoBrandWithProducts & { history: GeoAliasHistoryEntry[] }> {
	assertGeoPermission(principal, "brand.read");
	const brand = await loadBrand(db, principal.organizationId, id);
	const [products, versions] = await Promise.all([
		db
			.select()
			.from(geoProducts)
			.where(and(eq(geoProducts.organizationId, principal.organizationId), eq(geoProducts.brandEntityId, id)))
			.orderBy(asc(geoProducts.createdAt)),
		db
			.select({
				version: geoDictionaryVersions.version,
				changes: geoDictionaryVersions.changes,
				changeNote: geoDictionaryVersions.changeNote,
				createdBy: geoDictionaryVersions.createdBy,
				createdAt: geoDictionaryVersions.createdAt,
			})
			.from(geoDictionaryVersions)
			.where(
				and(
					eq(geoDictionaryVersions.organizationId, principal.organizationId),
					sql`${geoDictionaryVersions.changedEntityIds} @> ARRAY[${id}]::uuid[]`,
				),
			)
			.orderBy(desc(geoDictionaryVersions.version))
			.limit(200),
	]);
	const history = versions.flatMap(({ changes, ...version }) =>
		changes.filter((change) => change.entityId === id).map((change) => ({ ...version, ...change })),
	);
	return { ...brand, products, history };
}

export async function createBrand(principal: GeoPrincipal, raw: GeoBrandInput): Promise<GeoBrandEntity> {
	assertGeoPermission(principal, "brand.manage");
	const input = brandInputSchema.parse(raw);
	return db.transaction((tx) => insertBrandInTransaction(tx, principal, input));
}

/** For callers that must add a brand atomically with their own writes; the caller checks permission. */
export async function insertBrandInTransaction(
	tx: DbConnection,
	principal: GeoPrincipal,
	input: z.output<typeof brandInputSchema>,
): Promise<GeoBrandEntity> {
	const terms = cleanTerms({
		displayName: input.displayName,
		legalName: input.legalName,
		shortName: input.shortName,
		aliases: input.aliases,
		historicalNames: input.historicalNames,
		domains: input.domains,
	});
	await lockGeoDictionary(tx, principal.organizationId);
	await assertNoConflicts(tx, principal.organizationId, terms);
	const [row] = await tx
		.insert(geoBrandEntities)
		.values({
			...terms,
			organizationId: principal.organizationId,
			kind: input.kind,
			officialUrl: input.officialUrl,
			regions: dedupeBrandTerms(input.regions),
			factStatus: input.factStatus ?? "UNVERIFIED",
			factNotes: input.factNotes ?? [],
			createdBy: principal.actorId,
		})
		.returning();
	if (!row) throw new Error("Brand insert returned no row");
	const version = await appendDictionaryVersion(
		tx,
		principal,
		input.changeNote ?? `新增${input.kind === "OWN" ? "品牌" : "竞品"}“${row.displayName}”`,
	);
	await writeGeoAudit(tx, {
		principal,
		action: "brand.create",
		entityType: "brand",
		entityId: row.id,
		after: row,
		metadata: { dictionaryVersion: version.version },
	});
	return row;
}

export async function updateBrand(principal: GeoPrincipal, id: string, raw: GeoBrandPatch): Promise<GeoBrandEntity> {
	assertGeoPermission(principal, "brand.manage");
	const patch = brandPatchSchema.parse(raw);

	return db.transaction(async (tx) => {
		await lockGeoDictionary(tx, principal.organizationId);
		const before = await loadBrand(tx, principal.organizationId, id, true);
		const next = mergeBrandPatch(before, patch);
		if (sameValues(next, before)) return before;

		if (next.status === "ACTIVE") await assertNoConflicts(tx, principal.organizationId, { ...next, id });
		const [row] = await tx
			.update(geoBrandEntities)
			.set({ ...next, updatedAt: new Date() })
			.where(eq(geoBrandEntities.id, id))
			.returning();
		if (!row) throw new Error("Brand update returned no row");

		const change = statusChange(before.status, row.status);
		const version = await appendDictionaryVersion(
			tx,
			principal,
			patch.changeNote ?? `${CHANGE_VERBS[change]}“${row.displayName}”`,
		);
		await writeGeoAudit(tx, {
			principal,
			action: `brand.${change}`,
			entityType: "brand",
			entityId: row.id,
			before,
			after: row,
			metadata: { dictionaryVersion: version.version },
		});
		return row;
	});
}

async function assertProductUnique(
	tx: DbConnection,
	organizationId: string,
	candidate: { id?: string; brandEntityId: string; name: string; model: string | null },
) {
	const siblings = await tx
		.select({ id: geoProducts.id, name: geoProducts.name, model: geoProducts.model })
		.from(geoProducts)
		.where(and(eq(geoProducts.organizationId, organizationId), eq(geoProducts.brandEntityId, candidate.brandEntityId)));
	const key = (name: string, model: string | null) => `${normalizeBrandTerm(name)}|${normalizeBrandTerm(model ?? "")}`;
	const wanted = key(candidate.name, candidate.model);
	if (siblings.some((sibling) => sibling.id !== candidate.id && key(sibling.name, sibling.model) === wanted)) {
		throw new GeoError("CONFLICT", "该品牌下已存在相同名称和型号的产品");
	}
}

function assertProductTerm(input: { termKind: GeoProduct["termKind"]; model: string | null }) {
	const problem = productTermProblem(input);
	if (problem) throw new GeoError("VALIDATION_ERROR", problem);
}

export async function createProduct(
	principal: GeoPrincipal,
	brandId: string,
	raw: GeoProductInput,
): Promise<GeoProduct> {
	assertGeoPermission(principal, "brand.manage");
	const input = productInputSchema.parse(raw);
	assertProductTerm(input);

	return db.transaction(async (tx) => {
		await lockGeoDictionary(tx, principal.organizationId);
		const brand = await loadBrand(tx, principal.organizationId, brandId);
		await assertProductUnique(tx, principal.organizationId, { brandEntityId: brandId, ...input });
		const [row] = await tx
			.insert(geoProducts)
			.values({
				organizationId: principal.organizationId,
				brandEntityId: brandId,
				name: input.name,
				model: input.model,
				category: input.category,
				termKind: input.termKind,
				factStatus: input.factStatus ?? "UNVERIFIED",
				createdBy: principal.actorId,
			})
			.returning();
		if (!row) throw new Error("Product insert returned no row");
		const version = await appendDictionaryVersion(
			tx,
			principal,
			input.changeNote ?? `为“${brand.displayName}”新增产品“${row.model ?? row.name}”`,
		);
		await writeGeoAudit(tx, {
			principal,
			action: "product.create",
			entityType: "product",
			entityId: row.id,
			after: row,
			metadata: { dictionaryVersion: version.version },
		});
		return row;
	});
}

export async function updateProduct(
	principal: GeoPrincipal,
	brandId: string,
	productId: string,
	raw: GeoProductPatch,
): Promise<GeoProduct> {
	assertGeoPermission(principal, "brand.manage");
	const patch = productPatchSchema.parse(raw);

	return db.transaction(async (tx) => {
		await lockGeoDictionary(tx, principal.organizationId);
		const [before] = await tx
			.select()
			.from(geoProducts)
			.where(
				and(
					eq(geoProducts.organizationId, principal.organizationId),
					eq(geoProducts.brandEntityId, brandId),
					eq(geoProducts.id, productId),
				),
			)
			.for("update")
			.limit(1);
		if (!before) throw new GeoError("NOT_FOUND", "产品不存在");

		const next = mergeProductPatch(before, patch);
		if (sameValues(next, before)) return before;
		assertProductTerm(next);
		await assertProductUnique(tx, principal.organizationId, { id: productId, brandEntityId: brandId, ...next });

		const [row] = await tx
			.update(geoProducts)
			.set({ ...next, updatedAt: new Date() })
			.where(eq(geoProducts.id, productId))
			.returning();
		if (!row) throw new Error("Product update returned no row");
		const change = statusChange(before.status, row.status);
		const version = await appendDictionaryVersion(
			tx,
			principal,
			patch.changeNote ?? `${CHANGE_VERBS[change]}产品“${row.model ?? row.name}”`,
		);
		await writeGeoAudit(tx, {
			principal,
			action: `product.${change}`,
			entityType: "product",
			entityId: row.id,
			before,
			after: row,
			metadata: { dictionaryVersion: version.version },
		});
		return row;
	});
}

export interface GeoDictionaryVersionSummary {
	id: string;
	version: number;
	changeNote: string | null;
	changes: GeoDictionaryEntityChange[];
	createdBy: string;
	createdAt: Date;
}

export async function listDictionaryVersions(
	principal: GeoPrincipal,
	paging: { limit: number; offset: number },
): Promise<{ rows: GeoDictionaryVersionSummary[]; total: number }> {
	assertGeoPermission(principal, "brand.read");
	const where = eq(geoDictionaryVersions.organizationId, principal.organizationId);
	const [rows, [totals]] = await Promise.all([
		db
			.select({
				id: geoDictionaryVersions.id,
				version: geoDictionaryVersions.version,
				changeNote: geoDictionaryVersions.changeNote,
				changes: geoDictionaryVersions.changes,
				createdBy: geoDictionaryVersions.createdBy,
				createdAt: geoDictionaryVersions.createdAt,
			})
			.from(geoDictionaryVersions)
			.where(where)
			.orderBy(desc(geoDictionaryVersions.version))
			.limit(paging.limit)
			.offset(paging.offset),
		db.select({ total: count() }).from(geoDictionaryVersions).where(where),
	]);
	return { rows, total: totals?.total ?? 0 };
}

export async function getDictionaryVersionDetail(principal: GeoPrincipal, version: number) {
	assertGeoPermission(principal, "brand.read");
	const [row] = await db
		.select()
		.from(geoDictionaryVersions)
		.where(
			and(
				eq(geoDictionaryVersions.organizationId, principal.organizationId),
				eq(geoDictionaryVersions.version, version),
			),
		)
		.limit(1);
	if (!row) throw new GeoError("NOT_FOUND", "词典版本不存在");
	return row;
}
