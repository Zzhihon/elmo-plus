import {
	assertGeoPermission,
	assertGeoTransition,
	catalogAdoptionTransition,
	catalogPromptFreezeTransition,
	catalogSelectionProblem,
	catalogSetFreezeTransition,
	GEO_CATALOG_SELECTION_MAX,
	GEO_CATALOG_SELECTION_MIN,
	GEO_CATALOG_SET_NAME,
	GEO_DEFAULT_BUYER_ROLES,
	GEO_QUESTION_CATALOG,
	type GeoCatalogQuestion,
	GeoError,
	type GeoPrincipal,
	type GeoPromptStatus,
	normalizePromptQuestion,
	promptLabelsProblem,
	transitionActorOf,
} from "@workspace/geo-domain";
import { db } from "@workspace/lib/db/db";
import type { DbConnection } from "@workspace/lib/db/db-connection";
import { geoPromptSetItems, geoPromptSets, geoPrompts } from "@workspace/lib/db/schema";
import { writeGeoAudit } from "@workspace/lib/geo/audit";
import { listBuyerRolesSeeded } from "@workspace/lib/geo/buyer-roles";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { freezePromptSetInTransaction, insertPrompt, lockPromptLibrary, replaceDraftItems } from "./prompts-core";

export const catalogSelectionSchema = z.object({
	codes: z.array(z.string().trim().min(1).max(100)).max(GEO_CATALOG_SELECTION_MAX),
});

export interface GeoCatalogItemView {
	code: string;
	question: string;
	buyerRoleCode: string;
	intent: string;
	productLine: string;
	geoRegion: string;
	recommended: boolean;
	monitored: boolean;
	/** A reviewer rejected this wording in the question library, so it cannot be picked here. */
	unavailable: boolean;
}

export interface GeoQuestionCatalogView {
	roles: { code: string; title: string }[];
	items: GeoCatalogItemView[];
	/** False until the first save: the page then starts from the recommended selection. */
	hasSelection: boolean;
	savedAt: string | null;
	min: number;
	max: number;
}

async function latestSet(tx: DbConnection, organizationId: string, name: string) {
	const [set] = await tx
		.select()
		.from(geoPromptSets)
		.where(and(eq(geoPromptSets.organizationId, organizationId), eq(geoPromptSets.name, name)))
		.orderBy(desc(geoPromptSets.version))
		.limit(1);
	return set ?? null;
}

async function latestFrozenSet(tx: DbConnection, organizationId: string, name: string) {
	const [set] = await tx
		.select()
		.from(geoPromptSets)
		.where(
			and(
				eq(geoPromptSets.organizationId, organizationId),
				eq(geoPromptSets.name, name),
				eq(geoPromptSets.status, "FROZEN"),
			),
		)
		.orderBy(desc(geoPromptSets.version))
		.limit(1);
	return set ?? null;
}

export async function getQuestionCatalog(principal: GeoPrincipal): Promise<GeoQuestionCatalogView> {
	assertGeoPermission(principal, "prompt.read");
	const organizationId = principal.organizationId;
	const [roles, prompts, frozen] = await Promise.all([
		listBuyerRolesSeeded(db, organizationId),
		db
			.select({ question: geoPrompts.question, status: geoPrompts.status })
			.from(geoPrompts)
			.where(eq(geoPrompts.organizationId, organizationId)),
		latestFrozenSet(db, organizationId, GEO_CATALOG_SET_NAME),
	]);
	const monitored = new Set<string>();
	if (frozen) {
		const items = await db
			.select({ questionText: geoPromptSetItems.questionText })
			.from(geoPromptSetItems)
			.where(eq(geoPromptSetItems.setId, frozen.id));
		for (const item of items) monitored.add(normalizePromptQuestion(item.questionText));
	}
	const statusByQuestion = new Map(prompts.map((prompt) => [normalizePromptQuestion(prompt.question), prompt.status]));
	const titles = new Map(roles.map((role) => [role.code, role.title]));

	return {
		roles: GEO_DEFAULT_BUYER_ROLES.map((role) => ({ code: role.code, title: titles.get(role.code) ?? role.title })),
		items: GEO_QUESTION_CATALOG.map((item) => {
			const key = normalizePromptQuestion(item.question);
			return {
				code: item.code,
				question: item.question,
				buyerRoleCode: item.buyerRoleCode,
				intent: item.intent,
				productLine: item.productLine,
				geoRegion: item.geoRegion,
				recommended: item.recommended,
				monitored: monitored.has(key),
				unavailable: statusByQuestion.get(key) === "REJECTED",
			};
		}),
		hasSelection: frozen !== null,
		savedAt: frozen?.frozenAt?.toISOString() ?? null,
		min: GEO_CATALOG_SELECTION_MIN,
		max: GEO_CATALOG_SELECTION_MAX,
	};
}

export interface GeoCatalogSetResult {
	setId: string;
	version: number;
	changed: boolean;
}

/**
 * Turns catalog questions into reviewed prompts and freezes them as the next version of
 * `setName`. A question already in the library is reused rather than added twice, and
 * the same selection saved again changes nothing.
 */
export async function adoptCatalogQuestions(
	principal: GeoPrincipal,
	setName: string,
	questions: readonly GeoCatalogQuestion[],
): Promise<GeoCatalogSetResult> {
	assertGeoPermission(principal, "prompt.select_catalog");
	const actor = transitionActorOf(principal);
	const organizationId = principal.organizationId;

	return db.transaction(async (tx) => {
		await lockPromptLibrary(tx, organizationId);
		await tx.execute(
			sql`select pg_advisory_xact_lock(hashtextextended(${`geo-prompt-set:${organizationId}:${setName}`}, 0))`,
		);

		const roles = await listBuyerRolesSeeded(tx, organizationId);
		const roleIdByCode = new Map(roles.map((role) => [role.code, role.id]));
		const existing = await tx.select().from(geoPrompts).where(eq(geoPrompts.organizationId, organizationId));
		const byQuestion = new Map(existing.map((prompt) => [normalizePromptQuestion(prompt.question), prompt]));

		const chosen: { id: string; revision: number }[] = [];
		for (const item of questions) {
			const prompt = await adoptQuestion(tx, principal, item, {
				existing: byQuestion.get(normalizePromptQuestion(item.question)),
				buyerRoleId: roleIdByCode.get(item.buyerRoleCode),
			});
			chosen.push({ id: prompt.id, revision: prompt.currentRevision });
		}

		const previous = await latestSet(tx, organizationId, setName);
		if (previous?.status === "FROZEN" && (await sameItems(tx, previous.id, chosen))) {
			return { setId: previous.id, version: previous.version, changed: false };
		}
		const set = previous?.status === "DRAFT" ? previous : await insertSet(tx, principal, setName, previous);
		await replaceDraftItems(
			tx,
			organizationId,
			set.id,
			chosen.map((item) => item.id),
		);
		await freezePromptSetInTransaction(
			tx,
			principal,
			set.id,
			{
				set: (status, itemCount) => catalogSetFreezeTransition(status, actor, itemCount),
				prompt: (status) => catalogPromptFreezeTransition(status, actor),
			},
			{ source: "catalog" },
		);
		return { setId: set.id, version: set.version, changed: true };
	});
}

type GeoPromptRow = typeof geoPrompts.$inferSelect;

async function adoptQuestion(
	tx: DbConnection,
	principal: GeoPrincipal,
	item: GeoCatalogQuestion,
	found: { existing: GeoPromptRow | undefined; buyerRoleId: string | undefined },
): Promise<GeoPromptRow> {
	let prompt = found.existing;
	if (!prompt) {
		if (!found.buyerRoleId) throw new GeoError("VALIDATION_ERROR", `买方角色 ${item.buyerRoleCode} 不存在`);
		prompt = await insertPrompt(tx, principal, {
			question: item.question,
			buyerRoleId: found.buyerRoleId,
			intent: item.intent,
			productLine: item.productLine,
			geoRegion: item.geoRegion,
			priority: item.priority,
			language: "zh-CN",
			tier: item.tier,
			ownerId: null,
			sourceNote: `预设问题 ${item.code}`,
		});
	}
	const to = assertGeoTransition(catalogAdoptionTransition(prompt.status, transitionActorOf(principal)));
	return to === prompt.status ? prompt : markAdopted(tx, principal, prompt, to, item.code);
}

async function markAdopted(
	tx: DbConnection,
	principal: GeoPrincipal,
	before: GeoPromptRow,
	to: GeoPromptStatus,
	code: string,
) {
	const problem = promptLabelsProblem(before);
	if (problem) throw new GeoError("VALIDATION_ERROR", `“${before.question}”${problem}`);
	const [row] = await tx
		.update(geoPrompts)
		.set({ status: to, reviewerId: principal.actorId, reviewNote: "从预设问题中选定", updatedAt: new Date() })
		.where(eq(geoPrompts.id, before.id))
		.returning();
	if (!row) throw new Error("Prompt update returned no row");
	await writeGeoAudit(tx, {
		principal,
		action: "prompt.select_catalog",
		entityType: "prompt",
		entityId: row.id,
		before,
		after: row,
		metadata: { from: before.status, to, catalogCode: code },
	});
	return row;
}

async function sameItems(tx: DbConnection, setId: string, chosen: { id: string; revision: number }[]) {
	const items = await tx
		.select({ promptId: geoPromptSetItems.promptId, revision: geoPromptSetItems.promptRevision })
		.from(geoPromptSetItems)
		.where(eq(geoPromptSetItems.setId, setId));
	if (items.length !== chosen.length) return false;
	const pinned = new Map(items.map((item) => [item.promptId, item.revision]));
	return chosen.every((item) => pinned.get(item.id) === item.revision);
}

async function insertSet(
	tx: DbConnection,
	principal: GeoPrincipal,
	name: string,
	previous: { id: string; version: number } | null,
) {
	const [set] = await tx
		.insert(geoPromptSets)
		.values({
			organizationId: principal.organizationId,
			name,
			version: (previous?.version ?? 0) + 1,
			parentSetId: previous?.id ?? null,
			status: "DRAFT",
			createdBy: principal.actorId,
		})
		.returning();
	if (!set) throw new Error("Prompt set insert returned no row");
	await writeGeoAudit(tx, {
		principal,
		action: "prompt_set.create",
		entityType: "prompt_set",
		entityId: set.id,
		after: set,
		metadata: { source: "catalog" },
	});
	return set;
}

export async function saveCatalogSelection(
	principal: GeoPrincipal,
	raw: z.input<typeof catalogSelectionSchema>,
): Promise<GeoCatalogSetResult> {
	const { codes } = catalogSelectionSchema.parse(raw);
	const unique = [...new Set(codes)];
	const byCode = new Map(GEO_QUESTION_CATALOG.map((item) => [item.code, item]));
	const unknown = unique.filter((code) => !byCode.has(code));
	if (unknown.length > 0) throw new GeoError("VALIDATION_ERROR", `未知的预设问题：${unknown.join("、")}`);
	const problem = catalogSelectionProblem(unique.length);
	if (problem) throw new GeoError("VALIDATION_ERROR", problem);
	// Catalog order, so the set reads the same however the boxes were ticked.
	const questions = GEO_QUESTION_CATALOG.filter((item) => unique.includes(item.code));
	return adoptCatalogQuestions(principal, GEO_CATALOG_SET_NAME, questions);
}
