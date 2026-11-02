import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
	dedupeBrandTerms,
	describeBrandConflicts,
	findBrandConflicts,
	GEO_BRAND_KINDS,
	GEO_PRIORITIES,
	GEO_PROMPT_TIERS,
	GeoError,
	type GeoPrincipal,
	type GeoPromptLabels,
	geoSystemPrincipal,
	normalizeBrandDomain,
	normalizePromptQuestion,
} from "@workspace/geo-domain";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { DbConnection } from "../db/db-connection";
import { organization } from "../db/schema-auth";
import { geoBrandEntities, geoBuyerRoles, geoPromptRevisions, geoPrompts } from "../db/schema-geo";
import { writeGeoAudit } from "./audit";
import { seedDefaultBuyerRoles } from "./buyer-roles";
import { appendDictionaryVersion, lockGeoDictionary } from "./dictionary";

const brandSchema = z.object({
	kind: z.enum(GEO_BRAND_KINDS),
	displayName: z.string().trim().min(1).max(200),
	legalName: z.string().trim().max(200).nullish(),
	shortName: z.string().trim().max(100).nullish(),
	aliases: z.array(z.string().trim().min(1).max(200)).default([]),
	historicalNames: z.array(z.string().trim().min(1).max(200)).default([]),
	domains: z.array(z.string().trim().min(1).max(253)).default([]),
	officialUrl: z.url({ protocol: /^https?$/ }).nullish(),
	regions: z.array(z.string().trim().min(1).max(100)).default([]),
	/** Facts from outside material, held as unconfirmed notes until the customer signs them off. */
	factNotes: z.array(z.string().trim().min(1).max(500)).default([]),
});

const roleSchema = z.object({
	code: z.string().trim().min(1).max(64),
	title: z.string().trim().min(1).max(100),
	priority: z.number().int().min(0).max(100).default(0),
});

const promptSchema = z.object({
	question: z.string().trim().min(1).max(500),
	buyerRoleCode: z.string().trim().min(1).max(64),
	intent: z.string().trim().max(200).nullish(),
	productLine: z.string().trim().max(200).nullish(),
	geoRegion: z.string().trim().max(100).nullish(),
	priority: z.enum(GEO_PRIORITIES).default("P2"),
	language: z.string().trim().min(2).max(20).default("zh-CN"),
	tier: z.enum(GEO_PROMPT_TIERS).default("CORE"),
	sourceNote: z.string().trim().max(500).nullish(),
});

const fileSchema = z.looseObject({
	organization: z.object({ id: z.string().min(1).optional(), slug: z.string().min(1).optional() }).optional(),
	brands: z.array(z.unknown()).optional(),
	roles: z.array(z.unknown()).optional(),
	prompts: z.array(z.unknown()).optional(),
});

export type GeoBootstrapResult = { created: number; skipped: number };
export type GeoBootstrapApplier = (
	db: DbConnection,
	organizationId: string,
	section: unknown,
) => Promise<GeoBootstrapResult>;

function bootstrapBrandTerms(brand: z.output<typeof brandSchema>) {
	const legalName = brand.legalName ?? null;
	const shortName = brand.shortName ?? null;
	const ownNames = [brand.displayName, legalName, shortName];
	return {
		displayName: brand.displayName,
		legalName,
		shortName,
		aliases: dedupeBrandTerms(brand.aliases, ownNames),
		historicalNames: dedupeBrandTerms(brand.historicalNames, ownNames),
		domains: brand.domains.map((domain) => {
			const normalized = normalizeBrandDomain(domain);
			if (!normalized) throw new GeoError("VALIDATION_ERROR", `引导配置中的域名无效：${domain}`);
			return normalized;
		}),
	};
}

function bootstrapPrincipal(organizationId: string): GeoPrincipal {
	return geoSystemPrincipal(organizationId, "bootstrap", randomUUID());
}

/**
 * Only fills in what is missing. A brand someone has since edited or disabled keeps its
 * current state, so restarting the worker can never undo work done in the product.
 */
export async function applyGeoBootstrapBrands(
	db: DbConnection,
	organizationId: string,
	section: unknown,
): Promise<GeoBootstrapResult> {
	const brands = z.array(brandSchema).parse(section);
	const principal = bootstrapPrincipal(organizationId);

	return db.transaction(async (tx) => {
		await lockGeoDictionary(tx, organizationId);
		const existing = await tx
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
		const known = new Set(existing.map((brand) => brand.displayName));

		let created = 0;
		let skipped = 0;
		for (const brand of brands) {
			if (known.has(brand.displayName)) {
				skipped += 1;
				continue;
			}
			const candidate = bootstrapBrandTerms(brand);
			const conflicts = findBrandConflicts(candidate, existing);
			if (conflicts.length > 0) {
				throw new GeoError("CONFLICT", `引导配置“${brand.displayName}”冲突：${describeBrandConflicts(conflicts)}`);
			}

			const [row] = await tx
				.insert(geoBrandEntities)
				.values({
					...candidate,
					organizationId,
					kind: brand.kind,
					officialUrl: brand.officialUrl ?? null,
					regions: brand.regions,
					factStatus: "UNVERIFIED",
					factNotes: brand.factNotes,
					createdBy: principal.actorId,
				})
				.returning();
			if (!row) throw new Error("Brand insert returned no row");
			await writeGeoAudit(tx, {
				principal,
				action: "brand.create",
				entityType: "brand",
				entityId: row.id,
				after: row,
				metadata: { source: "bootstrap" },
			});
			existing.push(row);
			known.add(row.displayName);
			created += 1;
		}

		if (created > 0) await appendDictionaryVersion(tx, principal, `引导配置导入 ${created} 个品牌或竞品`);
		return { created, skipped };
	});
}

/**
 * Roles have no editor in the product, so the file is their only source and may
 * reorder or retitle them; the customer's priority order is part of that config.
 */
export async function applyGeoBootstrapRoles(
	db: DbConnection,
	organizationId: string,
	section: unknown,
): Promise<GeoBootstrapResult> {
	const roles = z.array(roleSchema).parse(section);
	await seedDefaultBuyerRoles(db, organizationId);
	if (roles.length === 0) return { created: 0, skipped: 0 };

	const before = await db
		.select({ code: geoBuyerRoles.code })
		.from(geoBuyerRoles)
		.where(eq(geoBuyerRoles.organizationId, organizationId));
	const known = new Set(before.map((role) => role.code));
	await db
		.insert(geoBuyerRoles)
		.values(roles.map((role) => ({ ...role, organizationId })))
		.onConflictDoUpdate({
			target: [geoBuyerRoles.organizationId, geoBuyerRoles.code],
			set: { title: sql`excluded.title`, priority: sql`excluded.priority`, updatedAt: new Date() },
		});
	const created = roles.filter((role) => !known.has(role.code)).length;
	return { created, skipped: roles.length - created };
}

/** Always drafts: an imported question still has to pass a person's business review. */
export async function applyGeoBootstrapPrompts(
	db: DbConnection,
	organizationId: string,
	section: unknown,
): Promise<GeoBootstrapResult> {
	const prompts = z.array(promptSchema).parse(section);
	const principal = bootstrapPrincipal(organizationId);
	await seedDefaultBuyerRoles(db, organizationId);

	return db.transaction(async (tx) => {
		const roles = await tx.select().from(geoBuyerRoles).where(eq(geoBuyerRoles.organizationId, organizationId));
		const rolesByCode = new Map(roles.map((role) => [role.code, role]));
		const existing = await tx
			.select({ question: geoPrompts.question })
			.from(geoPrompts)
			.where(eq(geoPrompts.organizationId, organizationId));
		const known = new Set(existing.map((prompt) => normalizePromptQuestion(prompt.question)));

		let created = 0;
		let skipped = 0;
		for (const prompt of prompts) {
			const key = normalizePromptQuestion(prompt.question);
			if (known.has(key)) {
				skipped += 1;
				continue;
			}
			const role = rolesByCode.get(prompt.buyerRoleCode);
			if (!role) throw new GeoError("VALIDATION_ERROR", `引导配置中的买方角色不存在：${prompt.buyerRoleCode}`);

			const labels: GeoPromptLabels = {
				buyerRoleId: role.id,
				buyerRoleCode: role.code,
				buyerRoleTitle: role.title,
				intent: prompt.intent ?? null,
				productLine: prompt.productLine ?? null,
				geoRegion: prompt.geoRegion ?? null,
				priority: prompt.priority,
				language: prompt.language,
				tier: prompt.tier,
				ownerId: null,
			};
			const [row] = await tx
				.insert(geoPrompts)
				.values({
					organizationId,
					question: prompt.question,
					buyerRoleId: role.id,
					intent: labels.intent,
					productLine: labels.productLine,
					geoRegion: labels.geoRegion,
					priority: labels.priority,
					language: labels.language,
					tier: labels.tier,
					status: "DRAFT",
					sourceNote: prompt.sourceNote ?? null,
					createdBy: principal.actorId,
				})
				.returning();
			if (!row) throw new Error("Prompt insert returned no row");
			await tx.insert(geoPromptRevisions).values({
				organizationId,
				promptId: row.id,
				revision: 1,
				snapshot: { question: row.question, sourceNote: row.sourceNote, ...labels },
				editorId: principal.actorId,
			});
			await writeGeoAudit(tx, {
				principal,
				action: "prompt.create",
				entityType: "prompt",
				entityId: row.id,
				after: row,
				metadata: { source: "bootstrap" },
			});
			known.add(key);
			created += 1;
		}
		return { created, skipped };
	});
}

async function resolveOrganizationId(
	db: DbConnection,
	target: { id?: string; slug?: string } | undefined,
): Promise<string | null> {
	const where = target?.id
		? eq(organization.id, target.id)
		: target?.slug
			? eq(organization.slug, target.slug)
			: undefined;
	const rows = await db.select({ id: organization.id }).from(organization).where(where).limit(2);
	// Without an explicit target, more than one organization would be a guess.
	return rows.length === 1 ? (rows[0]?.id ?? null) : null;
}

export interface GeoBootstrapReport {
	organizationId: string;
	sections: Record<string, GeoBootstrapResult>;
}

const CORE_APPLIERS: [string, GeoBootstrapApplier][] = [
	["roles", applyGeoBootstrapRoles],
	["brands", applyGeoBootstrapBrands],
	["prompts", applyGeoBootstrapPrompts],
];

/**
 * Null when there is nothing to do: no path configured, no file there, or the target
 * organization does not exist yet (the next worker start tries again). A file that is
 * present but wrong throws, so a mistake in customer config cannot pass as "imported".
 */
export async function runGeoBootstrap(
	db: DbConnection,
	options: { path?: string; appliers?: Record<string, GeoBootstrapApplier> } = {},
): Promise<GeoBootstrapReport | null> {
	const path = options.path ?? process.env.GEO_BOOTSTRAP_PATH;
	if (!path) return null;

	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}

	const file = fileSchema.parse(JSON.parse(raw));
	const organizationId = await resolveOrganizationId(db, file.organization);
	if (!organizationId) return null;

	const sections: Record<string, GeoBootstrapResult> = {};
	for (const [key, apply] of [...CORE_APPLIERS, ...Object.entries(options.appliers ?? {})]) {
		const section = file[key];
		if (section !== undefined) sections[key] = await apply(db, organizationId, section);
	}
	return { organizationId, sections };
}
