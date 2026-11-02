import { GeoError, type GeoPrincipal, geoSystemPrincipal } from "@workspace/geo-domain";
import type { DbConnection } from "@workspace/lib/db/db-connection";
import { geoSiteProfileVersions, geoSiteSources } from "@workspace/lib/db/schema";
import { geoAuditHash, writeGeoAudit } from "@workspace/lib/geo/audit";
import { and, desc, eq } from "drizzle-orm";
import type { z } from "zod";
import { URL_REFUSAL_LABELS } from "../net/url-policy";
import { defaultSiteProfile, type SiteOpWindow, type SiteProfile, safeParseSiteProfile } from "../profile";
import {
	checkSourceUrls,
	policyVersionOf,
	type RefusedUrl,
	type SiteSourceConfig,
	siteSourceConfigSchema,
} from "../source-config";

export type SiteSourceRow = typeof geoSiteSources.$inferSelect;

export class SiteUrlRefusedError extends GeoError {
	constructor(readonly refused: RefusedUrl[]) {
		super(
			"VALIDATION_ERROR",
			`以下网址不在授权范围内：${refused
				.slice(0, 5)
				.map((entry) => `${entry.url}（${URL_REFUSAL_LABELS[entry.reason]}）`)
				.join("；")}${refused.length > 5 ? ` 等 ${refused.length} 个` : ""}`,
		);
	}
}

function zodMessage(error: z.ZodError): string {
	return error.issues
		.slice(0, 5)
		.map((issue) => `${issue.path.join(".") || "配置"}：${issue.message}`)
		.join("；");
}

export function parseSourceConfig(input: unknown): SiteSourceConfig {
	const parsed = siteSourceConfigSchema.safeParse(input);
	if (!parsed.success) throw new GeoError("VALIDATION_ERROR", `站点配置无效：${zodMessage(parsed.error)}`);
	return parsed.data;
}

export function profileOfSource(source: Pick<SiteSourceRow, "profile">): SiteProfile {
	const parsed = safeParseSiteProfile(source.profile);
	return parsed.success ? parsed.data : defaultSiteProfile();
}

export function configOfSource(source: SiteSourceRow): SiteSourceConfig {
	return {
		baseUrl: source.baseUrl,
		allowedHosts: source.allowedHosts,
		seedUrls: source.seedUrls,
		keyUrls: source.keyUrls,
		profile: profileOfSource(source),
		requestsPerSecond: source.requestsPerSecond,
		maxPages: source.maxPages ?? 500,
		maxAssetBytes: source.maxAssetBytes ?? 20 * 1024 * 1024,
		opWindow: (source.opWindow as SiteOpWindow | null) ?? null,
		crawlCron: source.crawlCron,
		userAgentContact: source.userAgentContact,
		authorizationNote: source.authorizationNote,
		enabled: source.enabled,
	};
}

/**
 * UAT-21: a refused URL is evidence of an attempt to widen the crawl, so it is
 * audited on its own connection, outside the transaction the refusal rolls back.
 */
export async function auditRefusedUrls(
	db: DbConnection,
	principal: GeoPrincipal,
	refused: RefusedUrl[],
	context: { siteSourceId?: string; action: string },
): Promise<void> {
	await writeGeoAudit(db, {
		principal,
		action: "site.url_refused",
		entityType: "site_source",
		entityId: context.siteSourceId ?? "new",
		metadata: {
			attemptedAction: context.action,
			refused: refused.map((entry) => ({ field: entry.field, url: entry.url.slice(0, 500), reason: entry.reason })),
		},
	});
}

function checkedConfig(config: SiteSourceConfig): SiteSourceConfig {
	const checked = checkSourceUrls(config);
	if (checked.refused.length > 0) throw new SiteUrlRefusedError(checked.refused);
	return { ...config, baseUrl: checked.baseUrl, seedUrls: checked.seedUrls, keyUrls: checked.keyUrls };
}

/** jsonb returns keys in its own order, so a profile read back never stringifies the way it was written. */
function sameValue(a: unknown, b: unknown): boolean {
	return geoAuditHash(a) === geoAuditHash(b);
}

function rowValues(config: SiteSourceConfig) {
	return {
		baseUrl: config.baseUrl,
		allowedHosts: config.allowedHosts,
		seedUrls: config.seedUrls,
		keyUrls: config.keyUrls,
		profile: config.profile,
		policyVersion: policyVersionOf(config),
		requestsPerSecond: config.requestsPerSecond,
		concurrency: 1,
		maxPages: config.maxPages,
		maxAssetBytes: config.maxAssetBytes,
		opWindow: config.opWindow,
		crawlCron: config.crawlCron,
		userAgentContact: config.userAgentContact,
		authorizationNote: config.authorizationNote,
		enabled: config.enabled,
	};
}

async function recordProfileVersion(
	tx: DbConnection,
	principal: GeoPrincipal,
	sourceId: string,
	profile: SiteProfile,
): Promise<void> {
	await tx
		.insert(geoSiteProfileVersions)
		.values({
			organizationId: principal.organizationId,
			siteSourceId: sourceId,
			version: profile.version,
			profile,
			createdBy: principal.actorId,
		})
		.onConflictDoNothing();
}

export async function createSiteSource(
	tx: DbConnection,
	principal: GeoPrincipal,
	input: unknown,
): Promise<SiteSourceRow> {
	const config = checkedConfig(parseSourceConfig(input));
	const [row] = await tx
		.insert(geoSiteSources)
		.values({ organizationId: principal.organizationId, createdBy: principal.actorId, ...rowValues(config) })
		.onConflictDoNothing()
		.returning();
	if (!row) throw new GeoError("CONFLICT", "该站点已经登记过");
	await recordProfileVersion(tx, principal, row.id, config.profile);
	await writeGeoAudit(tx, {
		principal,
		action: "site.create",
		entityType: "site_source",
		entityId: row.id,
		after: rowValues(config),
		metadata: { baseUrl: config.baseUrl, allowedHosts: config.allowedHosts, profileVersion: config.profile.version },
	});
	return row;
}

export async function loadSiteSource(
	db: DbConnection,
	organizationId: string,
	sourceId: string,
): Promise<SiteSourceRow> {
	const [row] = await db
		.select()
		.from(geoSiteSources)
		.where(and(eq(geoSiteSources.organizationId, organizationId), eq(geoSiteSources.id, sourceId)))
		.limit(1);
	if (!row) throw new GeoError("NOT_FOUND", "站点不存在");
	return row;
}

/**
 * A changed profile must carry a higher version: versions are how parse results
 * are told apart, so reusing one would make two rule sets indistinguishable.
 */
export async function updateSiteSource(
	tx: DbConnection,
	principal: GeoPrincipal,
	sourceId: string,
	patch: Record<string, unknown>,
): Promise<SiteSourceRow> {
	const existing = await loadSiteSource(tx, principal.organizationId, sourceId);
	const current = configOfSource(existing);
	const config = checkedConfig(parseSourceConfig({ ...current, ...patch }));
	const profileChanged = !sameValue(config.profile, current.profile);
	if (profileChanged && config.profile.version <= current.profile.version) {
		throw new GeoError("VALIDATION_ERROR", `解析配置有改动时版本号必须大于当前的 ${current.profile.version}`);
	}
	const [row] = await tx
		.update(geoSiteSources)
		.set(rowValues(config))
		.where(and(eq(geoSiteSources.organizationId, principal.organizationId), eq(geoSiteSources.id, sourceId)))
		.returning();
	if (profileChanged) await recordProfileVersion(tx, principal, sourceId, config.profile);
	await writeGeoAudit(tx, {
		principal,
		action: patch.enabled === false ? "site.pause" : patch.enabled === true ? "site.resume" : "site.update",
		entityType: "site_source",
		entityId: sourceId,
		before: rowValues(current),
		after: rowValues(config),
		metadata: { changedFields: Object.keys(patch), profileVersion: config.profile.version },
	});
	return row;
}

export async function listProfileVersions(db: DbConnection, organizationId: string, sourceId: string) {
	return db
		.select({
			version: geoSiteProfileVersions.version,
			createdBy: geoSiteProfileVersions.createdBy,
			createdAt: geoSiteProfileVersions.createdAt,
		})
		.from(geoSiteProfileVersions)
		.where(
			and(eq(geoSiteProfileVersions.organizationId, organizationId), eq(geoSiteProfileVersions.siteSourceId, sourceId)),
		)
		.orderBy(desc(geoSiteProfileVersions.version));
}

export async function loadProfileVersion(
	db: DbConnection,
	organizationId: string,
	sourceId: string,
	version: number,
): Promise<SiteProfile> {
	const [row] = await db
		.select({ profile: geoSiteProfileVersions.profile })
		.from(geoSiteProfileVersions)
		.where(
			and(
				eq(geoSiteProfileVersions.organizationId, organizationId),
				eq(geoSiteProfileVersions.siteSourceId, sourceId),
				eq(geoSiteProfileVersions.version, version),
			),
		)
		.limit(1);
	const parsed = row ? safeParseSiteProfile(row.profile) : null;
	if (!parsed?.success) throw new GeoError("NOT_FOUND", `解析配置版本 ${version} 不存在`);
	return parsed.data;
}

export interface BootstrapSitesResult {
	created: number;
	updated: number;
	unchanged: number;
}

/**
 * The `sites` section of the bootstrap file. Matching is by base URL, so running
 * it again changes nothing; a source is only rewritten when the file carries a
 * newer profile version or different settings.
 */
export async function applyGeoBootstrapSites(
	db: DbConnection,
	organizationId: string,
	section: unknown,
): Promise<BootstrapSitesResult> {
	const entries = Array.isArray(section) ? section : section ? [section] : [];
	const principal = geoSystemPrincipal(organizationId, "bootstrap", `bootstrap-sites-${Date.now()}`);
	const result: BootstrapSitesResult = { created: 0, updated: 0, unchanged: 0 };
	for (const entry of entries) {
		const config = checkedConfig(parseSourceConfig(entry));
		await db.transaction(async (tx) => {
			const [existing] = await tx
				.select()
				.from(geoSiteSources)
				.where(and(eq(geoSiteSources.organizationId, organizationId), eq(geoSiteSources.baseUrl, config.baseUrl)))
				.limit(1);
			if (!existing) {
				await createSiteSource(tx, principal, config);
				result.created++;
				return;
			}
			const current = configOfSource(existing);
			const same = sameValue(rowValues(current), rowValues(config));
			if (same || config.profile.version < current.profile.version) {
				result.unchanged++;
				return;
			}
			const patch = { ...config };
			if (config.profile.version === current.profile.version) patch.profile = current.profile;
			await updateSiteSource(tx, principal, existing.id, patch);
			result.updated++;
		});
	}
	return result;
}
