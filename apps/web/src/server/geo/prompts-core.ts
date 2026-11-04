import {
	assertGeoPermission,
	assertGeoTransition,
	GEO_PRIORITIES,
	GEO_PROMPT_CSV_COLUMNS,
	GEO_PROMPT_CSV_MAX_ROWS,
	GEO_PROMPT_QUESTION_MAX_LENGTH,
	GEO_PROMPT_STATUSES,
	GEO_PROMPT_TIERS,
	GeoError,
	type GeoPrincipal,
	type GeoPromptAction,
	type GeoPromptCsvColumn,
	type GeoPromptCsvError,
	type GeoPromptLabels,
	type GeoPromptRevisionSnapshot,
	type GeoPromptSetStatus,
	type GeoPromptStatus,
	type GeoTransitionResult,
	isPromptEditable,
	missingPromptCsvColumns,
	normalizePromptQuestion,
	promptCsvRoleLookup,
	promptLabelsProblem,
	promptSetFreezeTransition,
	promptTransition,
	toPromptCsv,
	transitionActorOf,
	validatePromptCsvRows,
} from "@workspace/geo-domain";
import { db } from "@workspace/lib/db/db";
import type { DbConnection } from "@workspace/lib/db/db-connection";
import {
	geoBuyerRoles,
	geoPromptRevisions,
	geoPromptSetItems,
	geoPromptSets,
	geoPrompts,
	member,
	user,
} from "@workspace/lib/db/schema";
import { writeGeoAudit } from "@workspace/lib/geo/audit";
import { type GeoBuyerRole, listBuyerRolesSeeded } from "@workspace/lib/geo/buyer-roles";
import { type GeoFrozenPromptSet, getFrozenPromptSet } from "@workspace/lib/geo/prompt-sets";
import { parse as parseCsv } from "csv-parse/sync";
import { and, asc, count, desc, eq, ilike, inArray, type SQL, sql } from "drizzle-orm";
import { z } from "zod";

export type GeoPrompt = typeof geoPrompts.$inferSelect;
export type GeoPromptSet = typeof geoPromptSets.$inferSelect;
export type { GeoBuyerRole };

const optionalText = (max: number) =>
	z
		.string()
		.trim()
		.max(max)
		.nullish()
		.transform((value) => value || null);

const labelFields = {
	buyerRoleId: z
		.uuid()
		.nullish()
		.transform((value) => value ?? null),
	intent: optionalText(200),
	productLine: optionalText(200),
	geoRegion: optionalText(100),
	priority: z.enum(GEO_PRIORITIES).default("P2"),
	language: z
		.string()
		.trim()
		.regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, "语言代码格式无效，例如 zh-CN")
		.default("zh-CN"),
	tier: z.enum(GEO_PROMPT_TIERS).default("CORE"),
	ownerId: z
		.string()
		.trim()
		.min(1)
		.max(200)
		.nullish()
		.transform((value) => value ?? null),
};

export const promptInputSchema = z.object({
	question: z.string().trim().min(1, "问法不能为空").max(GEO_PROMPT_QUESTION_MAX_LENGTH),
	...labelFields,
	sourceNote: optionalText(500),
});
export type GeoPromptInput = z.input<typeof promptInputSchema>;

export const promptPatchSchema = z
	.object({
		question: z.string().trim().min(1, "问法不能为空").max(GEO_PROMPT_QUESTION_MAX_LENGTH),
		buyerRoleId: labelFields.buyerRoleId,
		intent: labelFields.intent,
		productLine: labelFields.productLine,
		geoRegion: labelFields.geoRegion,
		priority: z.enum(GEO_PRIORITIES),
		language: labelFields.language.unwrap(),
		tier: z.enum(GEO_PROMPT_TIERS),
		ownerId: labelFields.ownerId,
		sourceNote: optionalText(500),
	})
	.partial();
export type GeoPromptPatch = z.input<typeof promptPatchSchema>;

const USER_ACTIONS = ["SUBMIT", "APPROVE", "REJECT", "REVISE"] as const satisfies readonly GeoPromptAction[];
export const promptTransitionSchema = z.object({
	action: z.enum(USER_ACTIONS),
	comment: optionalText(1000),
});
export type GeoPromptTransitionInput = z.input<typeof promptTransitionSchema>;

export const promptListQuerySchema = z.object({
	status: z.enum(GEO_PROMPT_STATUSES).optional(),
	tier: z.enum(GEO_PROMPT_TIERS).optional(),
	buyerRoleId: z.uuid().optional(),
	q: z.string().trim().max(200).optional(),
});
export type GeoPromptListQuery = z.input<typeof promptListQuerySchema>;

export const promptSetInputSchema = z.object({
	name: z.string().trim().min(1).max(100),
	promptIds: z.array(z.uuid()).max(500).default([]),
});
export const promptSetItemsSchema = z.object({ promptIds: z.array(z.uuid()).max(500) });

export interface GeoMemberOption {
	userId: string;
	name: string;
	email: string;
}

export interface GeoPromptRow extends GeoPrompt {
	buyerRoleCode: string | null;
	buyerRoleTitle: string | null;
	latestFrozenSet: { id: string; name: string; version: number } | null;
}

export interface GeoPromptRevision {
	revision: number;
	snapshot: GeoPromptRevisionSnapshot;
	editorId: string;
	createdAt: Date;
}

function questionKey(question: string): string {
	return normalizePromptQuestion(question);
}

async function assertQuestionUnique(tx: DbConnection, organizationId: string, question: string, exceptId?: string) {
	const rows = await tx
		.select({ id: geoPrompts.id, question: geoPrompts.question })
		.from(geoPrompts)
		.where(eq(geoPrompts.organizationId, organizationId));
	const wanted = questionKey(question);
	if (rows.some((row) => row.id !== exceptId && questionKey(row.question) === wanted)) {
		throw new GeoError("CONFLICT", "问法库中已存在相同问法");
	}
}

async function assertRoleInOrganization(tx: DbConnection, organizationId: string, roleId: string | null) {
	if (!roleId) return null;
	const [role] = await tx
		.select()
		.from(geoBuyerRoles)
		.where(and(eq(geoBuyerRoles.organizationId, organizationId), eq(geoBuyerRoles.id, roleId)))
		.limit(1);
	if (!role) throw new GeoError("VALIDATION_ERROR", "买方角色不存在");
	return role;
}

async function assertMember(tx: DbConnection, organizationId: string, userId: string | null) {
	if (!userId) return;
	const [row] = await tx
		.select({ id: member.id })
		.from(member)
		.where(and(eq(member.organizationId, organizationId), eq(member.userId, userId)))
		.limit(1);
	if (!row) throw new GeoError("VALIDATION_ERROR", "负责人不是本组织成员");
}

function labelsOf(prompt: GeoPrompt, role: GeoBuyerRole | null): GeoPromptLabels {
	return {
		buyerRoleId: prompt.buyerRoleId,
		buyerRoleCode: role?.code ?? null,
		buyerRoleTitle: role?.title ?? null,
		intent: prompt.intent,
		productLine: prompt.productLine,
		geoRegion: prompt.geoRegion,
		priority: prompt.priority,
		language: prompt.language,
		tier: prompt.tier,
		ownerId: prompt.ownerId,
	};
}

function revisionSnapshot(prompt: GeoPrompt, role: GeoBuyerRole | null): GeoPromptRevisionSnapshot {
	return { question: prompt.question, sourceNote: prompt.sourceNote, ...labelsOf(prompt, role) };
}

async function loadPrompt(tx: DbConnection, organizationId: string, id: string, lock = false): Promise<GeoPrompt> {
	const query = tx
		.select()
		.from(geoPrompts)
		.where(and(eq(geoPrompts.organizationId, organizationId), eq(geoPrompts.id, id)))
		.limit(1);
	const [row] = lock ? await query.for("update") : await query;
	if (!row) throw new GeoError("NOT_FOUND", "问法不存在");
	return row;
}

/** A user-made prompt is owned by its author unless someone else is named; keys and the system own nothing. */
function defaultOwner(principal: GeoPrincipal): string | null {
	return principal.actorKind === "user" ? principal.actorId : null;
}

export async function listGeoMembers(principal: GeoPrincipal): Promise<GeoMemberOption[]> {
	assertGeoPermission(principal, "prompt.read");
	return db
		.select({ userId: user.id, name: user.name, email: user.email })
		.from(member)
		.innerJoin(user, eq(user.id, member.userId))
		.where(eq(member.organizationId, principal.organizationId))
		.orderBy(asc(user.name));
}

export async function listBuyerRoles(principal: GeoPrincipal): Promise<GeoBuyerRole[]> {
	assertGeoPermission(principal, "prompt.read");
	return listBuyerRolesSeeded(db, principal.organizationId);
}

function promptConditions(organizationId: string, query: z.output<typeof promptListQuerySchema>): SQL[] {
	const conditions = [eq(geoPrompts.organizationId, organizationId)];
	if (query.status) conditions.push(eq(geoPrompts.status, query.status));
	if (query.tier) conditions.push(eq(geoPrompts.tier, query.tier));
	if (query.buyerRoleId) conditions.push(eq(geoPrompts.buyerRoleId, query.buyerRoleId));
	if (query.q) conditions.push(ilike(geoPrompts.question, `%${query.q.replace(/[\\%_]/g, "\\$&")}%`));
	return conditions;
}

async function latestFrozenSets(organizationId: string, promptIds: string[]) {
	if (promptIds.length === 0) return new Map<string, { id: string; name: string; version: number }>();
	const rows = await db
		.select({
			promptId: geoPromptSetItems.promptId,
			id: geoPromptSets.id,
			name: geoPromptSets.name,
			version: geoPromptSets.version,
			frozenAt: geoPromptSets.frozenAt,
		})
		.from(geoPromptSetItems)
		.innerJoin(geoPromptSets, eq(geoPromptSets.id, geoPromptSetItems.setId))
		.where(
			and(
				eq(geoPromptSetItems.organizationId, organizationId),
				eq(geoPromptSets.status, "FROZEN"),
				inArray(geoPromptSetItems.promptId, promptIds),
			),
		)
		.orderBy(desc(geoPromptSets.frozenAt));
	const latest = new Map<string, { id: string; name: string; version: number }>();
	for (const row of rows) {
		if (!latest.has(row.promptId)) latest.set(row.promptId, { id: row.id, name: row.name, version: row.version });
	}
	return latest;
}

async function withRoleAndSet(organizationId: string, prompts: GeoPrompt[]): Promise<GeoPromptRow[]> {
	const roles = await listBuyerRolesSeeded(db, organizationId);
	const rolesById = new Map(roles.map((role) => [role.id, role]));
	const sets = await latestFrozenSets(
		organizationId,
		prompts.map((prompt) => prompt.id),
	);
	return prompts.map((prompt) => {
		const role = prompt.buyerRoleId ? rolesById.get(prompt.buyerRoleId) : undefined;
		return {
			...prompt,
			buyerRoleCode: role?.code ?? null,
			buyerRoleTitle: role?.title ?? null,
			latestFrozenSet: sets.get(prompt.id) ?? null,
		};
	});
}

export async function listPrompts(
	principal: GeoPrincipal,
	rawQuery: GeoPromptListQuery,
	paging: { limit: number; offset: number },
): Promise<{ rows: GeoPromptRow[]; total: number }> {
	assertGeoPermission(principal, "prompt.read");
	const where = and(...promptConditions(principal.organizationId, promptListQuerySchema.parse(rawQuery)));
	const [rows, [totals]] = await Promise.all([
		db
			.select()
			.from(geoPrompts)
			.where(where)
			.orderBy(asc(geoPrompts.priority), asc(geoPrompts.createdAt))
			.limit(paging.limit)
			.offset(paging.offset),
		db.select({ total: count() }).from(geoPrompts).where(where),
	]);
	return { rows: await withRoleAndSet(principal.organizationId, rows), total: totals?.total ?? 0 };
}

export async function getPrompt(
	principal: GeoPrincipal,
	id: string,
): Promise<GeoPromptRow & { revisions: GeoPromptRevision[] }> {
	assertGeoPermission(principal, "prompt.read");
	const prompt = await loadPrompt(db, principal.organizationId, id);
	const [[row], revisions] = await Promise.all([
		withRoleAndSet(principal.organizationId, [prompt]),
		db
			.select({
				revision: geoPromptRevisions.revision,
				snapshot: geoPromptRevisions.snapshot,
				editorId: geoPromptRevisions.editorId,
				createdAt: geoPromptRevisions.createdAt,
			})
			.from(geoPromptRevisions)
			.where(and(eq(geoPromptRevisions.organizationId, principal.organizationId), eq(geoPromptRevisions.promptId, id)))
			.orderBy(desc(geoPromptRevisions.revision)),
	]);
	if (!row) throw new GeoError("NOT_FOUND", "问法不存在");
	return { ...row, revisions };
}

export async function insertPrompt(
	tx: DbConnection,
	principal: GeoPrincipal,
	input: z.output<typeof promptInputSchema>,
): Promise<GeoPrompt> {
	const role = await assertRoleInOrganization(tx, principal.organizationId, input.buyerRoleId);
	await assertMember(tx, principal.organizationId, input.ownerId);
	const [row] = await tx
		.insert(geoPrompts)
		.values({
			organizationId: principal.organizationId,
			question: input.question,
			buyerRoleId: input.buyerRoleId,
			intent: input.intent,
			productLine: input.productLine,
			geoRegion: input.geoRegion,
			priority: input.priority,
			language: input.language,
			tier: input.tier,
			ownerId: input.ownerId ?? defaultOwner(principal),
			sourceNote: input.sourceNote,
			status: "DRAFT",
			currentRevision: 1,
			createdBy: principal.actorId,
		})
		.returning();
	if (!row) throw new Error("Prompt insert returned no row");
	await tx.insert(geoPromptRevisions).values({
		organizationId: principal.organizationId,
		promptId: row.id,
		revision: 1,
		snapshot: revisionSnapshot(row, role),
		editorId: principal.actorId,
	});
	await writeGeoAudit(tx, { principal, action: "prompt.create", entityType: "prompt", entityId: row.id, after: row });
	return row;
}

export async function createPrompt(principal: GeoPrincipal, raw: GeoPromptInput): Promise<GeoPrompt> {
	assertGeoPermission(principal, "prompt.write");
	const input = promptInputSchema.parse(raw);
	return db.transaction(async (tx) => {
		await lockPromptLibrary(tx, principal.organizationId);
		await assertQuestionUnique(tx, principal.organizationId, input.question);
		return insertPrompt(tx, principal, input);
	});
}

/** Serializes the duplicate-question check with the insert that follows it. */
export async function lockPromptLibrary(tx: DbConnection, organizationId: string) {
	await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`geo-prompts:${organizationId}`}, 0))`);
}

/** Every saved edit is a new revision; a frozen set keeps pointing at the one it froze. */
async function applyPromptEdit(
	tx: DbConnection,
	principal: GeoPrincipal,
	before: GeoPrompt,
	patch: z.output<typeof promptPatchSchema>,
): Promise<GeoPrompt> {
	if (!isPromptEditable(before.status)) {
		throw new GeoError("CONFLICT", "只有草稿可以编辑；已审核或冻结的问法请先“修订”生成新草稿");
	}
	const next = {
		question: patch.question ?? before.question,
		buyerRoleId: patch.buyerRoleId === undefined ? before.buyerRoleId : patch.buyerRoleId,
		intent: patch.intent === undefined ? before.intent : patch.intent,
		productLine: patch.productLine === undefined ? before.productLine : patch.productLine,
		geoRegion: patch.geoRegion === undefined ? before.geoRegion : patch.geoRegion,
		priority: patch.priority ?? before.priority,
		language: patch.language ?? before.language,
		tier: patch.tier ?? before.tier,
		ownerId: patch.ownerId === undefined ? before.ownerId : patch.ownerId,
		sourceNote: patch.sourceNote === undefined ? before.sourceNote : patch.sourceNote,
	};
	if ((Object.keys(next) as (keyof typeof next)[]).every((key) => next[key] === before[key])) return before;
	if (next.question !== before.question) {
		await assertQuestionUnique(tx, principal.organizationId, next.question, before.id);
	}
	const role = await assertRoleInOrganization(tx, principal.organizationId, next.buyerRoleId);
	if (next.ownerId !== before.ownerId) await assertMember(tx, principal.organizationId, next.ownerId);

	const revision = before.currentRevision + 1;
	const [row] = await tx
		.update(geoPrompts)
		.set({ ...next, currentRevision: revision, updatedAt: new Date() })
		.where(eq(geoPrompts.id, before.id))
		.returning();
	if (!row) throw new Error("Prompt update returned no row");
	await tx.insert(geoPromptRevisions).values({
		organizationId: principal.organizationId,
		promptId: row.id,
		revision,
		snapshot: revisionSnapshot(row, role),
		editorId: principal.actorId,
	});
	await writeGeoAudit(tx, {
		principal,
		action: "prompt.update",
		entityType: "prompt",
		entityId: row.id,
		before,
		after: row,
		metadata: { revision },
	});
	return row;
}

export async function updatePrompt(principal: GeoPrincipal, id: string, raw: GeoPromptPatch): Promise<GeoPrompt> {
	assertGeoPermission(principal, "prompt.write");
	const patch = promptPatchSchema.parse(raw);
	return db.transaction(async (tx) => {
		await lockPromptLibrary(tx, principal.organizationId);
		const before = await loadPrompt(tx, principal.organizationId, id, true);
		return applyPromptEdit(tx, principal, before, patch);
	});
}

/** Anyone who shaped the question counts as its author for the no-self-review rule. */
async function authorsOf(tx: DbConnection, prompt: GeoPrompt): Promise<string[]> {
	const editors = await tx
		.selectDistinct({ editorId: geoPromptRevisions.editorId })
		.from(geoPromptRevisions)
		.where(eq(geoPromptRevisions.promptId, prompt.id));
	return [prompt.createdBy, prompt.ownerId, ...editors.map((row) => row.editorId)].filter((id): id is string =>
		Boolean(id),
	);
}

export async function transitionPrompt(
	principal: GeoPrincipal,
	id: string,
	raw: GeoPromptTransitionInput,
): Promise<GeoPrompt> {
	const { action, comment } = promptTransitionSchema.parse(raw);
	return db.transaction(async (tx) => {
		const before = await loadPrompt(tx, principal.organizationId, id, true);
		if (action === "SUBMIT") {
			const problem = promptLabelsProblem(before);
			if (problem) throw new GeoError("VALIDATION_ERROR", problem);
		}
		const to = assertGeoTransition(
			promptTransition({
				status: before.status,
				action,
				actor: transitionActorOf(principal),
				comment,
				authorIds: await authorsOf(tx, before),
			}),
		);
		const reviewed = action === "APPROVE" || action === "REJECT";
		const [row] = await tx
			.update(geoPrompts)
			.set({
				status: to,
				updatedAt: new Date(),
				...(reviewed && { reviewerId: principal.actorId, reviewNote: comment }),
				...(action === "SUBMIT" && { reviewerId: null, reviewNote: null }),
			})
			.where(eq(geoPrompts.id, id))
			.returning();
		if (!row) throw new Error("Prompt update returned no row");
		await writeGeoAudit(tx, {
			principal,
			action: `prompt.${action.toLowerCase()}`,
			entityType: "prompt",
			entityId: id,
			before,
			after: row,
			metadata: { from: before.status, to, ...(comment && { comment }) },
		});
		return row;
	});
}

// ---------------------------------------------------------------------------
// Prompt sets
// ---------------------------------------------------------------------------

export interface GeoPromptSetSummary extends GeoPromptSet {
	itemCount: number;
	coreCount: number;
}

export interface GeoPromptSetItemView {
	promptId: string;
	promptRevision: number;
	questionText: string;
	labels: GeoPromptLabels;
	currentStatus: GeoPromptStatus;
	currentRevision: number;
}

async function loadSet(tx: DbConnection, organizationId: string, id: string, lock = false): Promise<GeoPromptSet> {
	const query = tx
		.select()
		.from(geoPromptSets)
		.where(and(eq(geoPromptSets.organizationId, organizationId), eq(geoPromptSets.id, id)))
		.limit(1);
	const [row] = lock ? await query.for("update") : await query;
	if (!row) throw new GeoError("NOT_FOUND", "测试集不存在");
	return row;
}

export async function listPromptSets(principal: GeoPrincipal): Promise<GeoPromptSetSummary[]> {
	assertGeoPermission(principal, "prompt.read");
	const [sets, counts] = await Promise.all([
		db
			.select()
			.from(geoPromptSets)
			.where(eq(geoPromptSets.organizationId, principal.organizationId))
			.orderBy(asc(geoPromptSets.name), desc(geoPromptSets.version)),
		db
			.select({
				setId: geoPromptSetItems.setId,
				itemCount: count(),
				coreCount: sql<number>`count(*) filter (where ${geoPromptSetItems.labels}->>'tier' = 'CORE')`.mapWith(Number),
			})
			.from(geoPromptSetItems)
			.where(eq(geoPromptSetItems.organizationId, principal.organizationId))
			.groupBy(geoPromptSetItems.setId),
	]);
	const bySet = new Map(counts.map((row) => [row.setId, row]));
	return sets.map((set) => ({
		...set,
		itemCount: bySet.get(set.id)?.itemCount ?? 0,
		coreCount: bySet.get(set.id)?.coreCount ?? 0,
	}));
}

export async function getPromptSet(
	principal: GeoPrincipal,
	id: string,
): Promise<GeoPromptSet & { items: GeoPromptSetItemView[] }> {
	assertGeoPermission(principal, "prompt.read");
	const set = await loadSet(db, principal.organizationId, id);
	const items = await db
		.select({
			promptId: geoPromptSetItems.promptId,
			promptRevision: geoPromptSetItems.promptRevision,
			questionText: geoPromptSetItems.questionText,
			labels: geoPromptSetItems.labels,
			currentStatus: geoPrompts.status,
			currentRevision: geoPrompts.currentRevision,
		})
		.from(geoPromptSetItems)
		.innerJoin(geoPrompts, eq(geoPrompts.id, geoPromptSetItems.promptId))
		.where(and(eq(geoPromptSetItems.organizationId, principal.organizationId), eq(geoPromptSetItems.setId, id)))
		.orderBy(asc(geoPromptSetItems.createdAt), asc(geoPromptSetItems.promptId));
	return { ...set, items };
}

/**
 * Draft items mirror the prompts as they are now; only freezing pins them. Rewriting
 * them is safe because nothing may sample a set before it is frozen.
 */
export async function replaceDraftItems(tx: DbConnection, organizationId: string, setId: string, promptIds: string[]) {
	const unique = [...new Set(promptIds)];
	const prompts =
		unique.length === 0
			? []
			: await tx
					.select()
					.from(geoPrompts)
					.where(and(eq(geoPrompts.organizationId, organizationId), inArray(geoPrompts.id, unique)));
	if (prompts.length !== unique.length) throw new GeoError("NOT_FOUND", "部分问法不存在");
	const roles = await listBuyerRolesSeeded(tx, organizationId);
	const rolesById = new Map(roles.map((role) => [role.id, role]));

	await tx.delete(geoPromptSetItems).where(eq(geoPromptSetItems.setId, setId));
	if (prompts.length === 0) return;
	const order = new Map(unique.map((id, index) => [id, index]));
	prompts.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
	const base = Date.now();
	await tx.insert(geoPromptSetItems).values(
		prompts.map((prompt, index) => ({
			organizationId,
			setId,
			promptId: prompt.id,
			promptRevision: prompt.currentRevision,
			questionText: prompt.question,
			labels: labelsOf(prompt, (prompt.buyerRoleId && rolesById.get(prompt.buyerRoleId)) || null),
			createdAt: new Date(base + index),
		})),
	);
}

export async function createPromptSet(
	principal: GeoPrincipal,
	raw: z.input<typeof promptSetInputSchema>,
): Promise<GeoPromptSet> {
	assertGeoPermission(principal, "prompt.write");
	const input = promptSetInputSchema.parse(raw);
	return db.transaction(async (tx) => {
		await tx.execute(
			sql`select pg_advisory_xact_lock(hashtextextended(${`geo-prompt-set:${principal.organizationId}:${input.name}`}, 0))`,
		);
		const [latest] = await tx
			.select({ id: geoPromptSets.id, version: geoPromptSets.version, status: geoPromptSets.status })
			.from(geoPromptSets)
			.where(and(eq(geoPromptSets.organizationId, principal.organizationId), eq(geoPromptSets.name, input.name)))
			.orderBy(desc(geoPromptSets.version))
			.limit(1);
		if (latest?.status === "DRAFT") throw new GeoError("CONFLICT", "同名测试集已有未冻结的草稿版本，请直接编辑它");

		const [set] = await tx
			.insert(geoPromptSets)
			.values({
				organizationId: principal.organizationId,
				name: input.name,
				version: (latest?.version ?? 0) + 1,
				parentSetId: latest?.id ?? null,
				status: "DRAFT",
				createdBy: principal.actorId,
			})
			.returning();
		if (!set) throw new Error("Prompt set insert returned no row");
		await replaceDraftItems(tx, principal.organizationId, set.id, input.promptIds);
		await writeGeoAudit(tx, {
			principal,
			action: "prompt_set.create",
			entityType: "prompt_set",
			entityId: set.id,
			after: { ...set, promptIds: input.promptIds },
		});
		return set;
	});
}

export async function updatePromptSetItems(
	principal: GeoPrincipal,
	id: string,
	raw: z.input<typeof promptSetItemsSchema>,
): Promise<GeoPromptSet> {
	assertGeoPermission(principal, "prompt.write");
	const { promptIds } = promptSetItemsSchema.parse(raw);
	return db.transaction(async (tx) => {
		const set = await loadSet(tx, principal.organizationId, id, true);
		if (set.status !== "DRAFT") throw new GeoError("CONFLICT", "测试集已冻结，修改必须生成新版本");
		const before = await tx
			.select({ promptId: geoPromptSetItems.promptId })
			.from(geoPromptSetItems)
			.where(eq(geoPromptSetItems.setId, id));
		await replaceDraftItems(tx, principal.organizationId, id, promptIds);
		const [row] = await tx
			.update(geoPromptSets)
			.set({ updatedAt: new Date() })
			.where(eq(geoPromptSets.id, id))
			.returning();
		await writeGeoAudit(tx, {
			principal,
			action: "prompt_set.update_items",
			entityType: "prompt_set",
			entityId: id,
			before: before.map((item) => item.promptId),
			after: promptIds,
		});
		return row ?? set;
	});
}

/** Editing a frozen set means starting its next version; the frozen one is never touched. */
export async function createNextPromptSetVersion(principal: GeoPrincipal, id: string): Promise<GeoPromptSet> {
	assertGeoPermission(principal, "prompt.write");
	const source = await getPromptSet(principal, id);
	if (source.status !== "FROZEN") throw new GeoError("CONFLICT", "只能从已冻结的测试集生成新版本");
	return createPromptSet(principal, {
		name: source.name,
		promptIds: source.items.map((item) => item.promptId),
	});
}

const FREEZABLE: readonly GeoPromptStatus[] = ["BASELINE", "FROZEN"];

export interface GeoPromptSetFreezeRules {
	set: (status: GeoPromptSetStatus, itemCount: number) => GeoTransitionResult<GeoPromptSetStatus>;
	prompt: (status: GeoPromptStatus) => GeoTransitionResult<GeoPromptStatus>;
}

/**
 * Pins every item to the revision it has now. A prompt already frozen by an earlier set
 * is included as is; anything not through business review blocks the freeze.
 */
export async function freezePromptSetInTransaction(
	tx: DbConnection,
	principal: GeoPrincipal,
	id: string,
	rules: GeoPromptSetFreezeRules,
	auditMetadata: Record<string, unknown> = {},
): Promise<void> {
	const set = await loadSet(tx, principal.organizationId, id, true);
	const items = await tx
		.select({ promptId: geoPromptSetItems.promptId })
		.from(geoPromptSetItems)
		.where(eq(geoPromptSetItems.setId, id));
	assertGeoTransition(rules.set(set.status, items.length));

	const promptIds = items.map((item) => item.promptId);
	const prompts = await tx
		.select()
		.from(geoPrompts)
		.where(and(eq(geoPrompts.organizationId, principal.organizationId), inArray(geoPrompts.id, promptIds)))
		.orderBy(asc(geoPrompts.id))
		.for("update");
	const blocked = prompts.filter((prompt) => !FREEZABLE.includes(prompt.status));
	if (blocked.length > 0) {
		const sample = blocked
			.slice(0, 3)
			.map((prompt) => `“${prompt.question}”`)
			.join("、");
		throw new GeoError(
			"VALIDATION_ERROR",
			`${blocked.length} 条问法尚未通过业务审核，不能冻结：${sample}${blocked.length > 3 ? " 等" : ""}`,
		);
	}

	// Re-snapshot in the item order the set already had.
	const existingOrder = await tx
		.select({ promptId: geoPromptSetItems.promptId })
		.from(geoPromptSetItems)
		.where(eq(geoPromptSetItems.setId, id))
		.orderBy(asc(geoPromptSetItems.createdAt), asc(geoPromptSetItems.promptId));
	await replaceDraftItems(
		tx,
		principal.organizationId,
		id,
		existingOrder.map((item) => item.promptId),
	);

	const toFreeze = prompts.filter((prompt) => prompt.status === "BASELINE");
	for (const prompt of toFreeze) assertGeoTransition(rules.prompt(prompt.status));
	if (toFreeze.length > 0) {
		await tx
			.update(geoPrompts)
			.set({ status: "FROZEN", updatedAt: new Date() })
			.where(
				inArray(
					geoPrompts.id,
					toFreeze.map((prompt) => prompt.id),
				),
			);
	}

	const now = new Date();
	const [frozen] = await tx
		.update(geoPromptSets)
		.set({ status: "FROZEN", frozenAt: now, frozenBy: principal.actorId, updatedAt: now })
		.where(eq(geoPromptSets.id, id))
		.returning();
	await writeGeoAudit(tx, {
		principal,
		action: "prompt_set.freeze",
		entityType: "prompt_set",
		entityId: id,
		before: set,
		after: frozen,
		metadata: {
			...auditMetadata,
			itemCount: prompts.length,
			promptsFrozen: toFreeze.map((prompt) => prompt.id),
		},
	});
}

export async function freezePromptSet(principal: GeoPrincipal, id: string): Promise<GeoFrozenPromptSet> {
	assertGeoPermission(principal, "prompt.freeze");
	const actor = transitionActorOf(principal);
	await db.transaction((tx) =>
		freezePromptSetInTransaction(tx, principal, id, {
			set: (status, itemCount) => promptSetFreezeTransition(status, actor, itemCount),
			prompt: (status) => promptTransition({ status, action: "FREEZE", actor }),
		}),
	);
	return getFrozenPromptSet(db, principal.organizationId, id, { includeExtended: true });
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

export const GEO_PROMPT_CSV_MAX_BYTES = 1024 * 1024;

export async function exportPromptsCsv(principal: GeoPrincipal, rawQuery: GeoPromptListQuery): Promise<string> {
	assertGeoPermission(principal, "prompt.read");
	const prompts = await db
		.select()
		.from(geoPrompts)
		.where(and(...promptConditions(principal.organizationId, promptListQuerySchema.parse(rawQuery))))
		.orderBy(asc(geoPrompts.priority), asc(geoPrompts.createdAt))
		.limit(10_000);
	const rows = await withRoleAndSet(principal.organizationId, prompts);
	return toPromptCsv(
		rows.map(
			(row): Record<GeoPromptCsvColumn, string> => ({
				prompt_id: row.id,
				question: row.question,
				buyer_role: row.buyerRoleCode ?? "",
				intent: row.intent ?? "",
				product_line: row.productLine ?? "",
				geo_region: row.geoRegion ?? "",
				priority: row.priority,
				language: row.language,
				tier: row.tier,
				status: row.status,
				test_set_version: row.latestFrozenSet ? `${row.latestFrozenSet.name} v${row.latestFrozenSet.version}` : "",
				owner: row.ownerId ?? "",
			}),
		),
	);
}

export interface GeoPromptImportResult {
	created: number;
	updated: number;
	unchanged: number;
	errors: GeoPromptCsvError[];
}

interface CsvRecord {
	record: Record<string, string>;
	info: { lines: number };
}

function parsePromptCsv(text: string): { header: string[]; rows: { line: number; cells: Record<string, string> }[] } {
	if (Buffer.byteLength(text, "utf8") > GEO_PROMPT_CSV_MAX_BYTES) {
		throw new GeoError("VALIDATION_ERROR", "CSV 文件不能超过 1 MB");
	}
	let header: string[] = [];
	let records: CsvRecord[];
	try {
		records = parseCsv(text, {
			bom: true,
			columns: (names: string[]) => {
				header = names.map((name) => name.trim());
				return header;
			},
			skip_empty_lines: true,
			trim: false,
			info: true,
			max_record_size: 16 * 1024,
		}) as CsvRecord[];
	} catch (error) {
		const line = (error as { lines?: number }).lines;
		throw new GeoError("VALIDATION_ERROR", `CSV 格式错误${line ? `（第 ${line} 行）` : ""}，请检查引号和列数`);
	}
	if (records.length > GEO_PROMPT_CSV_MAX_ROWS) {
		throw new GeoError("VALIDATION_ERROR", `单次最多导入 ${GEO_PROMPT_CSV_MAX_ROWS} 行`);
	}
	const unknown = header.filter((name) => !(GEO_PROMPT_CSV_COLUMNS as readonly string[]).includes(name));
	if (unknown.length > 0) throw new GeoError("VALIDATION_ERROR", `未知列：${unknown.join("、")}`);
	const missing = missingPromptCsvColumns(header);
	if (missing.length > 0) throw new GeoError("VALIDATION_ERROR", `缺少必填列：${missing.join("、")}`);
	return { header, rows: records.map(({ record, info }) => ({ line: info.lines, cells: record })) };
}

/** All or nothing: one bad row rejects the file, so a partial import never has to be untangled. */
export async function importPromptsCsv(principal: GeoPrincipal, text: string): Promise<GeoPromptImportResult> {
	assertGeoPermission(principal, "prompt.write");
	const { rows } = parsePromptCsv(text);
	if (rows.length === 0) throw new GeoError("VALIDATION_ERROR", "CSV 中没有数据行");

	return db.transaction(async (tx) => {
		await lockPromptLibrary(tx, principal.organizationId);
		const roles = await listBuyerRolesSeeded(tx, principal.organizationId);
		const existing = await tx
			.select({
				id: geoPrompts.id,
				question: geoPrompts.question,
				status: geoPrompts.status,
				buyerRoleId: geoPrompts.buyerRoleId,
				intent: geoPrompts.intent,
				productLine: geoPrompts.productLine,
				geoRegion: geoPrompts.geoRegion,
				priority: geoPrompts.priority,
				language: geoPrompts.language,
				tier: geoPrompts.tier,
				ownerId: geoPrompts.ownerId,
			})
			.from(geoPrompts)
			.where(eq(geoPrompts.organizationId, principal.organizationId));
		const members = await tx
			.select({ userId: member.userId })
			.from(member)
			.where(eq(member.organizationId, principal.organizationId));
		const {
			valid,
			unchanged: untouched,
			errors,
		} = validatePromptCsvRows(rows, {
			roles: promptCsvRoleLookup(roles),
			existing,
			memberIds: new Set(members.map((row) => row.userId)),
		});
		if (errors.length > 0) return { created: 0, updated: 0, unchanged: 0, errors };

		let created = 0;
		let updated = 0;
		let unchanged = untouched.length;
		for (const row of valid) {
			const fields = {
				question: row.question,
				buyerRoleId: row.buyerRoleId,
				intent: row.intent,
				productLine: row.productLine,
				geoRegion: row.geoRegion,
				priority: row.priority,
				language: row.language,
				tier: row.tier,
				ownerId: row.ownerId,
			};
			if (!row.promptId) {
				await insertPrompt(tx, principal, { ...fields, sourceNote: null });
				created += 1;
				continue;
			}
			const before = await loadPrompt(tx, principal.organizationId, row.promptId, true);
			const after = await applyPromptEdit(tx, principal, before, fields);
			if (after === before) unchanged += 1;
			else updated += 1;
		}
		await writeGeoAudit(tx, {
			principal,
			action: "prompt.import_csv",
			entityType: "prompt",
			entityId: principal.organizationId,
			metadata: { rows: valid.length + untouched.length, created, updated, unchanged },
		});
		return { created, updated, unchanged, errors: [] };
	});
}

export async function promptStatusCounts(principal: GeoPrincipal): Promise<Record<GeoPromptStatus, number>> {
	assertGeoPermission(principal, "prompt.read");
	const rows = await db
		.select({ status: geoPrompts.status, total: count() })
		.from(geoPrompts)
		.where(eq(geoPrompts.organizationId, principal.organizationId))
		.groupBy(geoPrompts.status);
	const counts = Object.fromEntries(GEO_PROMPT_STATUSES.map((status) => [status, 0])) as Record<
		GeoPromptStatus,
		number
	>;
	for (const row of rows) counts[row.status] = row.total;
	return counts;
}

export interface GeoRoleCoverage {
	buyerRoleId: string | null;
	core: number;
	coreReviewed: number;
	extended: number;
}

/** Shows which buyer roles the reviewed core questions actually reach. */
export async function promptRoleCoverage(principal: GeoPrincipal): Promise<GeoRoleCoverage[]> {
	assertGeoPermission(principal, "prompt.read");
	return db
		.select({
			buyerRoleId: geoPrompts.buyerRoleId,
			core: sql<number>`count(*) filter (where ${geoPrompts.tier} = 'CORE')`.mapWith(Number),
			coreReviewed:
				sql<number>`count(*) filter (where ${geoPrompts.tier} = 'CORE' and ${geoPrompts.status} in ('BASELINE', 'FROZEN'))`.mapWith(
					Number,
				),
			extended: sql<number>`count(*) filter (where ${geoPrompts.tier} = 'EXTENDED')`.mapWith(Number),
		})
		.from(geoPrompts)
		.where(eq(geoPrompts.organizationId, principal.organizationId))
		.groupBy(geoPrompts.buyerRoleId);
}

export interface GeoPromptOption {
	id: string;
	question: string;
	status: GeoPromptStatus;
	tier: GeoPrompt["tier"];
	priority: GeoPrompt["priority"];
	buyerRoleId: string | null;
}

export async function listPromptOptions(principal: GeoPrincipal): Promise<GeoPromptOption[]> {
	assertGeoPermission(principal, "prompt.read");
	return db
		.select({
			id: geoPrompts.id,
			question: geoPrompts.question,
			status: geoPrompts.status,
			tier: geoPrompts.tier,
			priority: geoPrompts.priority,
			buyerRoleId: geoPrompts.buyerRoleId,
		})
		.from(geoPrompts)
		.where(eq(geoPrompts.organizationId, principal.organizationId))
		.orderBy(asc(geoPrompts.priority), asc(geoPrompts.createdAt))
		.limit(2000);
}
