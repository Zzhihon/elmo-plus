import type { GeoActiveStatus, GeoBrandKind, GeoFactStatus, GeoTermKind } from "./enums";

export interface GeoDictionaryEntity {
	id: string;
	kind: GeoBrandKind;
	displayName: string;
	legalName: string | null;
	shortName: string | null;
	aliases: string[];
	historicalNames: string[];
	domains: string[];
	officialUrl: string | null;
	regions: string[];
	status: GeoActiveStatus;
	factStatus: GeoFactStatus;
}

export interface GeoDictionaryProduct {
	id: string;
	brandEntityId: string;
	model: string | null;
	name: string;
	category: string | null;
	termKind: GeoTermKind;
	factStatus: GeoFactStatus;
	status: GeoActiveStatus;
}

/** What an evaluation matched against, kept whole so later edits cannot change how it reads. */
export interface GeoDictionarySnapshot {
	entities: GeoDictionaryEntity[];
	products: GeoDictionaryProduct[];
}

export interface GeoDictionaryEntityChange {
	entityId: string;
	displayName: string;
	addedAliases: string[];
	removedAliases: string[];
	addedHistoricalNames: string[];
	removedHistoricalNames: string[];
	changedFields: string[];
}

/** Width, case and spacing differences must not let the same name in twice. */
export function normalizeBrandTerm(term: string): string {
	return term.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}

/** Keeps the first spelling of each term, and drops anything in `exclude`. */
export function dedupeBrandTerms(terms: readonly string[], exclude: readonly (string | null)[] = []): string[] {
	const seen = new Set(exclude.filter((term): term is string => Boolean(term)).map(normalizeBrandTerm));
	const unique: string[] = [];
	for (const raw of terms) {
		const term = raw.trim();
		const key = normalizeBrandTerm(term);
		if (!key || seen.has(key)) continue;
		seen.add(key);
		unique.push(term);
	}
	return unique;
}

const HOST_SHAPE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}[a-z0-9]$/;

/** Null when the input is not a host name; a URL is reduced to its host. */
export function normalizeBrandDomain(input: string): string | null {
	const lowered = input.trim().toLowerCase();
	const host = lowered
		.replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
		.split(/[/?#]/, 1)[0]
		?.replace(/:\d+$/, "")
		.replace(/\.$/, "");
	return host && HOST_SHAPE.test(host) ? host : null;
}

function domainIdentity(domain: string): string {
	return domain.replace(/^www\./, "");
}

export interface GeoBrandTerms {
	displayName: string;
	legalName?: string | null;
	shortName?: string | null;
	aliases?: readonly string[];
	historicalNames?: readonly string[];
	domains?: readonly string[];
}

export interface GeoBrandConflictSubject extends GeoBrandTerms {
	id: string;
	status: GeoActiveStatus;
}

export interface GeoBrandConflict {
	field: "name" | "domain";
	term: string;
	entityId: string;
	entityName: string;
}

function namesOf(entity: GeoBrandTerms): string[] {
	return [
		entity.displayName,
		entity.legalName ?? "",
		entity.shortName ?? "",
		...(entity.aliases ?? []),
		...(entity.historicalNames ?? []),
	].filter(Boolean);
}

/**
 * Two active entities sharing a name would make every mention of it ambiguous. A
 * disabled entity no longer matches anything, so only its display name stays taken:
 * that name identifies it, and it has to be found again when re-enabled.
 */
export function findBrandConflicts(
	candidate: GeoBrandTerms & { id?: string },
	others: readonly GeoBrandConflictSubject[],
): GeoBrandConflict[] {
	const candidateNames = namesOf(candidate);
	const candidateDomains = candidate.domains ?? [];
	return others
		.filter((other) => other.id !== candidate.id)
		.flatMap((other) => [
			...nameConflicts(candidateNames, other),
			...(other.status === "ACTIVE" ? domainConflicts(candidateDomains, other) : []),
		]);
}

function nameConflicts(names: readonly string[], other: GeoBrandConflictSubject): GeoBrandConflict[] {
	const taken = new Set((other.status === "ACTIVE" ? namesOf(other) : [other.displayName]).map(normalizeBrandTerm));
	return names
		.filter((name) => taken.has(normalizeBrandTerm(name)))
		.map((term) => ({ field: "name", term, entityId: other.id, entityName: other.displayName }));
}

function domainConflicts(domains: readonly string[], other: GeoBrandConflictSubject): GeoBrandConflict[] {
	const taken = new Set((other.domains ?? []).map(domainIdentity));
	return domains
		.filter((domain) => taken.has(domainIdentity(domain)))
		.map((term) => ({ field: "domain", term, entityId: other.id, entityName: other.displayName }));
}

export function describeBrandConflicts(conflicts: readonly GeoBrandConflict[]): string {
	return conflicts
		.map(({ field, term, entityName }) =>
			field === "name" ? `名称“${term}”已被“${entityName}”使用` : `域名“${term}”已归属“${entityName}”`,
		)
		.join("；");
}

function added(next: readonly string[], prev: readonly string[]): string[] {
	const known = new Set(prev.map(normalizeBrandTerm));
	return next.filter((term) => !known.has(normalizeBrandTerm(term)));
}

const COMPARED_FIELDS = [
	"displayName",
	"legalName",
	"shortName",
	"domains",
	"officialUrl",
	"regions",
	"status",
	"factStatus",
] as const satisfies readonly (keyof GeoDictionaryEntity)[];

const COMPARED_PRODUCT_FIELDS = [
	"brandEntityId",
	"model",
	"name",
	"category",
	"termKind",
	"factStatus",
	"status",
] as const satisfies readonly (keyof GeoDictionaryProduct)[];

/** A snapshot holds no history of its own, so each version records what it changed against the one before. */
export function diffDictionarySnapshots(
	prev: GeoDictionarySnapshot | null,
	next: GeoDictionarySnapshot,
): GeoDictionaryEntityChange[] {
	const prevEntities = new Map((prev?.entities ?? []).map((entity) => [entity.id, entity]));
	const prevProducts = new Map((prev?.products ?? []).map((product) => [product.id, product]));
	const changes: GeoDictionaryEntityChange[] = [];

	for (const entity of next.entities) {
		const before = prevEntities.get(entity.id);
		const changedFields: string[] = before
			? COMPARED_FIELDS.filter((field) => JSON.stringify(before[field]) !== JSON.stringify(entity[field]))
			: ["created"];
		const productChanged = next.products.some((product) => {
			if (product.brandEntityId !== entity.id) return false;
			const previous = prevProducts.get(product.id);
			return !previous || COMPARED_PRODUCT_FIELDS.some((field) => previous[field] !== product[field]);
		});
		if (productChanged) changedFields.push("products");

		const change: GeoDictionaryEntityChange = {
			entityId: entity.id,
			displayName: entity.displayName,
			addedAliases: added(entity.aliases, before?.aliases ?? []),
			removedAliases: added(before?.aliases ?? [], entity.aliases),
			addedHistoricalNames: added(entity.historicalNames, before?.historicalNames ?? []),
			removedHistoricalNames: added(before?.historicalNames ?? [], entity.historicalNames),
			changedFields,
		};
		const changed =
			changedFields.length > 0 ||
			change.addedAliases.length > 0 ||
			change.removedAliases.length > 0 ||
			change.addedHistoricalNames.length > 0 ||
			change.removedHistoricalNames.length > 0;
		if (changed) changes.push(change);
	}
	return changes;
}

/** A customer model is matched as an exact identifier, so it has no meaning without one. */
export function productTermProblem(input: { termKind: GeoTermKind; model?: string | null }): string | null {
	if (input.termKind === "CUSTOMER_MODEL" && !input.model?.trim()) return "客户型号必须填写型号";
	if (input.termKind === "GENERIC" && input.model?.trim()) return "通用产品词不能填写型号，请改为客户型号";
	return null;
}
