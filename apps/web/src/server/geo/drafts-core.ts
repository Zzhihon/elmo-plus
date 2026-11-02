import {
	assertGeoPermission,
	assertGeoTransition,
	contentTransition,
	draftFactProblems,
	GEO_CONTENT_APPROVAL_STATES,
	GEO_CONTENT_KINDS,
	type GeoContentAction,
	type GeoContentApprovalState,
	type GeoContentGenerator,
	type GeoContentKind,
	type GeoDraftValidation,
	GeoError,
	type GeoPrincipal,
	isContentExportable,
	isHttpUrl,
	transitionActorOf,
	validateDraft,
} from "@workspace/geo-domain";
import { db } from "@workspace/lib/db/db";
import type { DbConnection } from "@workspace/lib/db/db-connection";
import {
	geoContentItems,
	geoContentReviews,
	geoContentVersions,
	geoOptimizationTasks,
	geoOrgSettings,
	geoPublicationRecords,
} from "@workspace/lib/db/schema";
import { writeGeoAudit } from "@workspace/lib/geo/audit";
import { loadFactStates } from "@workspace/lib/geo/knowledge";
import { runStructuredCompletionPrompt } from "@workspace/lib/onboarding";
import { and, count, desc, eq, notInArray, type SQL } from "drizzle-orm";
import { z } from "zod";
import { buildDraftPrompt, type DraftClaim, renderDraftHtml, renderDraftMarkdown } from "./drafts-render";
import { loadDraftFacts } from "./knowledge-core";
import { displayNames, iso, nameOf, optionalText, type Paging, text } from "./knowledge-shared";

const MAX_FACTS = 40;
const BODY_MAX = 20_000;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const createDraftSchema = z
	.object({
		kind: z.enum(GEO_CONTENT_KINDS),
		title: text(200).min(1, "请填写标题"),
		taskId: z.string().uuid().nullish(),
		assertionIds: z.array(z.string().uuid()).min(1, "请至少选择一条已审核事实").max(MAX_FACTS),
		mode: z.enum(["LLM", "MANUAL"]),
		instructions: optionalText(1000),
		body: text(BODY_MAX).nullish(),
	})
	.refine((value) => value.mode === "LLM" || Boolean(value.body), { message: "手工撰写必须填写正文", path: ["body"] });
export type CreateDraftInput = z.infer<typeof createDraftSchema>;

export const reviseDraftSchema = z
	.object({
		title: text(200).min(1).optional(),
		assertionIds: z.array(z.string().uuid()).min(1).max(MAX_FACTS).optional(),
		mode: z.enum(["LLM", "MANUAL"]),
		instructions: optionalText(1000),
		body: text(BODY_MAX).nullish(),
		note: optionalText(2000),
	})
	.refine((value) => value.mode === "LLM" || Boolean(value.body), { message: "手工修改必须填写正文", path: ["body"] });
export type ReviseDraftInput = z.infer<typeof reviseDraftSchema>;

export const draftTransitionSchema = z.object({
	action: z.enum(["SUBMIT", "APPROVE_TECH", "APPROVE_MARKETING", "REJECT"]),
	comment: optionalText(4000),
});
export type DraftTransitionInput = z.infer<typeof draftTransitionSchema>;

export const publicationSchema = z.object({
	url: z.string().trim().max(2000).refine(isHttpUrl, "发布 URL 必须是 http 或 https 地址"),
	publishedAt: z.string().datetime({ offset: true }),
	proofNote: text(4000).min(1, "请填写发布凭证说明"),
	proofUrl: z.string().trim().max(2000).refine(isHttpUrl, "凭证链接必须是 http 或 https 地址").nullish(),
});
export type PublicationInput = z.infer<typeof publicationSchema>;

export const draftFiltersSchema = z.object({
	state: z.enum(GEO_CONTENT_APPROVAL_STATES).optional(),
	kind: z.enum(GEO_CONTENT_KINDS).optional(),
	taskId: z.string().uuid().optional(),
});
export type DraftFilters = z.infer<typeof draftFiltersSchema>;

export const draftLinkTaskSchema = z.object({ taskId: z.string().uuid().nullable() });

export const exportFormatSchema = z.object({ format: z.enum(["md", "html"]).default("md") });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ItemRow = typeof geoContentItems.$inferSelect;
type VersionRow = typeof geoContentVersions.$inferSelect;

interface StoredValidation {
	result: GeoDraftValidation;
	checkedAt: string;
}

function claimsOf(version: VersionRow): DraftClaim[] {
	return Array.isArray(version.claims) ? (version.claims as DraftClaim[]) : [];
}

function toClaims(facts: Awaited<ReturnType<typeof loadDraftFacts>>): DraftClaim[] {
	return facts.map((fact, index) => ({
		ref: `F${index + 1}`,
		assertionId: fact.id,
		entityTitle: fact.entity?.title ?? null,
		claimType: fact.claimType,
		fieldPath: fact.fieldPath,
		claimText: fact.claimText,
		normalizedValue: fact.normalizedValue,
		riskLevel: fact.riskLevel,
		validUntil: fact.validUntil,
		sources: fact.sources,
	}));
}

function validate(body: string, claims: readonly DraftClaim[]): GeoDraftValidation {
	return validateDraft(
		body,
		claims.map((claim) => ({
			ref: claim.ref,
			assertionId: claim.assertionId,
			claimText: claim.claimText,
			normalizedValue: claim.normalizedValue,
			entityTitle: claim.entityTitle,
			riskLevel: claim.riskLevel,
		})),
	);
}

async function assertLlmApproved(organizationId: string) {
	const [settings] = await db
		.select({ approved: geoOrgSettings.llmUseApproved })
		.from(geoOrgSettings)
		.where(eq(geoOrgSettings.organizationId, organizationId))
		.limit(1);
	if (!settings?.approved) {
		throw new GeoError(
			"FORBIDDEN",
			"组织尚未批准调用大模型，不能自动生成草稿。请由平台管理员在“设置”中发起并完成审批，或改用手工撰写。",
		);
	}
}

const draftOutputSchema = z.object({
	title: z.string().min(1).max(200),
	body: z.string().min(1).max(BODY_MAX),
});

async function generateBody(input: {
	organizationId: string;
	kind: GeoContentKind;
	title: string;
	instructions: string | null;
	claims: DraftClaim[];
}): Promise<{ title: string; body: string; model: string | null }> {
	await assertLlmApproved(input.organizationId);
	try {
		const result = await runStructuredCompletionPrompt(buildDraftPrompt(input), draftOutputSchema);
		const parsed = draftOutputSchema.parse(result.object);
		return { title: parsed.title, body: parsed.body, model: result.modelVersion ?? null };
	} catch (error) {
		console.error("[geo-drafts] generation failed", error);
		throw new GeoError("TARGET_UNAVAILABLE", "大模型生成失败，请稍后重试或改用手工撰写", { cause: error });
	}
}

async function loadItem(tx: DbConnection, principal: GeoPrincipal, id: string, lock = false): Promise<ItemRow> {
	const query = tx
		.select()
		.from(geoContentItems)
		.where(and(eq(geoContentItems.organizationId, principal.organizationId), eq(geoContentItems.id, id)))
		.limit(1);
	const [row] = lock ? await query.for("update") : await query;
	if (!row) throw new GeoError("NOT_FOUND", "草稿不存在");
	return row;
}

async function loadVersion(tx: DbConnection, item: ItemRow): Promise<VersionRow> {
	const [row] = await tx
		.select()
		.from(geoContentVersions)
		.where(and(eq(geoContentVersions.itemId, item.id), eq(geoContentVersions.version, item.currentVersion)))
		.limit(1);
	if (!row) throw new GeoError("NOT_FOUND", "草稿版本不存在");
	return row;
}

async function authorIdsOf(tx: DbConnection, item: ItemRow): Promise<string[]> {
	const rows = await tx
		.selectDistinct({ createdBy: geoContentVersions.createdBy })
		.from(geoContentVersions)
		.where(eq(geoContentVersions.itemId, item.id));
	return [...new Set([item.authorId, ...rows.map((row) => row.createdBy)])];
}

async function assertTask(tx: DbConnection, principal: GeoPrincipal, taskId: string) {
	const [task] = await tx
		.select({ id: geoOptimizationTasks.id, state: geoOptimizationTasks.state })
		.from(geoOptimizationTasks)
		.where(and(eq(geoOptimizationTasks.organizationId, principal.organizationId), eq(geoOptimizationTasks.id, taskId)))
		.limit(1);
	if (!task) throw new GeoError("NOT_FOUND", "工单不存在");
	if (task.state === "VERIFIED" || task.state === "CANCELLED") {
		throw new GeoError("CONFLICT", "工单已结束，不能关联草稿");
	}
}

/**
 * What blocks moving a version forward: a high-risk claim the facts do not
 * support, a citation to nothing, or a cited fact that is no longer approved,
 * public, in date, unfrozen and undisputed (UAT-08).
 */
async function releaseProblems(tx: DbConnection, principal: GeoPrincipal, version: VersionRow) {
	const claims = claimsOf(version);
	const validation = validate(version.body, claims);
	const cited = claims.filter((claim) => validation.citedRefs.includes(claim.ref));
	const states = await loadFactStates(
		tx,
		principal.organizationId,
		cited.map((claim) => claim.assertionId),
	);
	return { validation, factProblems: draftFactProblems(cited, states) };
}

function assertReleasable(problems: Awaited<ReturnType<typeof releaseProblems>>) {
	if (problems.validation.blocking) {
		throw new GeoError(
			"EVIDENCE_REQUIRED",
			`草稿中有 ${problems.validation.blockingCount} 处高风险内容找不到来源或与来源不一致，请修改后再提交`,
		);
	}
	if (problems.factProblems.length > 0) {
		const refs = problems.factProblems.map((problem) => problem.ref).join("、");
		throw new GeoError(
			"EVIDENCE_REQUIRED",
			`引用的事实 ${refs} 已失效（过期、冻结、存在冲突或不再公开），请修改后再提交`,
		);
	}
}

async function recordReview(
	tx: DbConnection,
	principal: GeoPrincipal,
	input: {
		item: ItemRow;
		version: number;
		action: GeoContentAction;
		to: GeoContentApprovalState;
		comment?: string | null;
	},
) {
	await tx.insert(geoContentReviews).values({
		organizationId: principal.organizationId,
		itemId: input.item.id,
		version: input.version,
		action: input.action,
		fromState: input.item.approvalState,
		toState: input.to,
		actorId: principal.actorId,
		comment: input.comment ?? null,
	});
}

// ---------------------------------------------------------------------------
// Create and revise
// ---------------------------------------------------------------------------

async function composeVersion(
	principal: GeoPrincipal,
	input: {
		kind: GeoContentKind;
		title: string;
		assertionIds: readonly string[];
		mode: GeoContentGenerator;
		instructions?: string | null;
		body?: string | null;
	},
) {
	const claims = toClaims(await loadDraftFacts(principal, input.assertionIds));
	if (claims.length === 0) throw new GeoError("VALIDATION_ERROR", "没有可用的已审核事实");
	let title = input.title;
	let body = input.body ?? "";
	let model: string | null = null;
	if (input.mode === "LLM") {
		const generated = await generateBody({
			organizationId: principal.organizationId,
			kind: input.kind,
			title: input.title,
			instructions: input.instructions ?? null,
			claims,
		});
		title = generated.title;
		body = generated.body;
		model = generated.model;
	}
	const validation: StoredValidation = { result: validate(body, claims), checkedAt: new Date().toISOString() };
	return { title, body, claims, model, validation };
}

/**
 * Only approved PUBLIC facts go in, and only after the organization approved
 * model use does a model see them. Every version is immutable.
 */
export async function createDraft(principal: GeoPrincipal, input: CreateDraftInput) {
	assertGeoPermission(principal, "content.write");
	const composed = await composeVersion(principal, input);
	return db.transaction(async (tx) => {
		if (input.taskId) await assertTask(tx, principal, input.taskId);
		const [item] = await tx
			.insert(geoContentItems)
			.values({
				organizationId: principal.organizationId,
				taskId: input.taskId ?? null,
				kind: input.kind,
				title: composed.title,
				approvalState: "DRAFT",
				currentVersion: 1,
				authorId: principal.actorId,
			})
			.returning();
		await tx.insert(geoContentVersions).values({
			organizationId: principal.organizationId,
			itemId: item.id,
			version: 1,
			body: composed.body,
			claims: composed.claims,
			generator: input.mode,
			model: composed.model,
			validation: composed.validation,
			createdBy: principal.actorId,
		});
		await writeGeoAudit(tx, {
			principal,
			action: "content.create",
			entityType: "content_item",
			entityId: item.id,
			after: { kind: item.kind, title: item.title, version: 1 },
			metadata: {
				generator: input.mode,
				model: composed.model,
				facts: composed.claims.length,
				blocking: composed.validation.result.blockingCount,
				pending: composed.validation.result.pendingCount,
			},
		});
		return { id: item.id, version: 1, validation: composed.validation.result };
	});
}

/** A new version; the old ones stay as they were. Any revision restarts both reviews. */
export async function reviseDraft(principal: GeoPrincipal, id: string, input: ReviseDraftInput) {
	assertGeoPermission(principal, "content.write");
	const item = await loadItem(db, principal, id);
	const previous = await loadVersion(db, item);
	const assertionIds = input.assertionIds ?? claimsOf(previous).map((claim) => claim.assertionId);
	const composed = await composeVersion(principal, {
		kind: item.kind,
		title: input.title ?? item.title,
		assertionIds,
		mode: input.mode,
		instructions: input.instructions,
		body: input.body,
	});
	return db.transaction(async (tx) => {
		const current = await loadItem(tx, principal, id, true);
		if (current.currentVersion !== item.currentVersion) {
			throw new GeoError("CONFLICT", "草稿已被他人修改，请刷新后重试");
		}
		const to = assertGeoTransition(
			contentTransition({
				item: { state: current.approvalState, authorIds: await authorIdsOf(tx, current) },
				action: "REVISE",
				actor: transitionActorOf(principal),
			}),
		);
		const version = current.currentVersion + 1;
		await tx.insert(geoContentVersions).values({
			organizationId: principal.organizationId,
			itemId: current.id,
			version,
			body: composed.body,
			claims: composed.claims,
			generator: input.mode,
			model: composed.model,
			validation: composed.validation,
			createdBy: principal.actorId,
		});
		await tx
			.update(geoContentItems)
			.set({ currentVersion: version, approvalState: to, title: composed.title })
			.where(eq(geoContentItems.id, current.id));
		await recordReview(tx, principal, { item: current, version, action: "REVISE", to, comment: input.note });
		await writeGeoAudit(tx, {
			principal,
			action: "content.revise",
			entityType: "content_item",
			entityId: current.id,
			before: { state: current.approvalState, version: current.currentVersion },
			after: { state: to, version },
			metadata: { generator: input.mode, model: composed.model, note: input.note ?? null },
		});
		return { id: current.id, version, validation: composed.validation.result };
	});
}

// ---------------------------------------------------------------------------
// Review flow
// ---------------------------------------------------------------------------

/** Technical review, then marketing review; the author never reviews, a rejection needs a comment. */
export async function transitionDraft(principal: GeoPrincipal, id: string, input: DraftTransitionInput) {
	return db.transaction(async (tx) => {
		const item = await loadItem(tx, principal, id, true);
		const to = assertGeoTransition(
			contentTransition({
				item: { state: item.approvalState, authorIds: await authorIdsOf(tx, item) },
				action: input.action,
				actor: transitionActorOf(principal),
				comment: input.comment,
			}),
		);
		if (input.action !== "REJECT") {
			const version = await loadVersion(tx, item);
			assertReleasable(await releaseProblems(tx, principal, version));
		}
		const reviewing = input.action !== "SUBMIT";
		await tx
			.update(geoContentItems)
			.set(
				reviewing
					? {
							approvalState: to,
							reviewNote: input.comment ?? null,
							reviewedBy: principal.actorId,
							reviewedAt: new Date(),
						}
					: { approvalState: to },
			)
			.where(eq(geoContentItems.id, item.id));
		await recordReview(tx, principal, {
			item,
			version: item.currentVersion,
			action: input.action,
			to,
			comment: input.comment,
		});
		await writeGeoAudit(tx, {
			principal,
			action: `content.${input.action.toLowerCase()}`,
			entityType: "content_item",
			entityId: item.id,
			before: { state: item.approvalState },
			after: { state: to },
			metadata: { version: item.currentVersion, comment: input.comment ?? null },
		});
		return { id: item.id, state: to };
	});
}

/** Only content that passed both reviews leaves as a release file, and only while its facts still hold. */
export async function exportDraft(principal: GeoPrincipal, id: string, format: "md" | "html"): Promise<Response> {
	assertGeoPermission(principal, "content.publish");
	const item = await loadItem(db, principal, id);
	if (!isContentExportable(item.approvalState)) {
		throw new GeoError("CONFLICT", "内容尚未通过技术和市场审核，不能导出发布版本");
	}
	const version = await loadVersion(db, item);
	assertReleasable(await releaseProblems(db, principal, version));
	const claims = claimsOf(version);
	const document =
		format === "html"
			? renderDraftHtml({ title: item.title, body: version.body, claims })
			: renderDraftMarkdown({ title: item.title, body: version.body, claims });
	await writeGeoAudit(db, {
		principal,
		action: "content.export",
		entityType: "content_item",
		entityId: item.id,
		metadata: { version: version.version, format },
	});
	return new Response(document, {
		headers: {
			"Content-Type": format === "html" ? "text/html; charset=utf-8" : "text/markdown; charset=utf-8",
			"Content-Disposition": `attachment; filename="content-${item.id}-v${version.version}.${format}"`,
			"Content-Security-Policy": "sandbox; default-src 'none'",
			"X-Content-Type-Options": "nosniff",
			"Cache-Control": "private, no-store",
		},
	});
}

/** The publisher records where the approved version went live; nothing is written to any CMS from here. */
export async function recordPublication(principal: GeoPrincipal, id: string, input: PublicationInput) {
	return db.transaction(async (tx) => {
		const item = await loadItem(tx, principal, id, true);
		const to = assertGeoTransition(
			contentTransition({
				item: { state: item.approvalState, authorIds: await authorIdsOf(tx, item) },
				action: "PUBLISH",
				actor: transitionActorOf(principal),
			}),
		);
		const publishedAt = new Date(input.publishedAt);
		if (publishedAt.getTime() > Date.now() + 5 * 60_000) {
			throw new GeoError("VALIDATION_ERROR", "发布时间不能晚于当前时间");
		}
		const [record] = await tx
			.insert(geoPublicationRecords)
			.values({
				organizationId: principal.organizationId,
				itemId: item.id,
				version: item.currentVersion,
				url: input.url,
				publishedAt,
				proof: { note: input.proofNote, url: input.proofUrl ?? null },
				recordedBy: principal.actorId,
			})
			.returning();
		await tx.update(geoContentItems).set({ approvalState: to }).where(eq(geoContentItems.id, item.id));
		await recordReview(tx, principal, { item, version: item.currentVersion, action: "PUBLISH", to });
		await writeGeoAudit(tx, {
			principal,
			action: "content.publish",
			entityType: "content_item",
			entityId: item.id,
			before: { state: item.approvalState },
			after: { state: to, url: input.url },
			metadata: { version: item.currentVersion, publicationId: record.id },
		});
		return { id: record.id, state: to };
	});
}

export async function linkDraftTask(principal: GeoPrincipal, id: string, taskId: string | null) {
	assertGeoPermission(principal, "content.write");
	return db.transaction(async (tx) => {
		const item = await loadItem(tx, principal, id, true);
		if (item.approvalState === "PUBLISHED") throw new GeoError("CONFLICT", "已发布的内容不能更换关联工单");
		if (taskId) await assertTask(tx, principal, taskId);
		await tx.update(geoContentItems).set({ taskId }).where(eq(geoContentItems.id, item.id));
		await writeGeoAudit(tx, {
			principal,
			action: "content.link_task",
			entityType: "content_item",
			entityId: item.id,
			before: { taskId: item.taskId },
			after: { taskId },
		});
		return { id: item.id, taskId };
	});
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listDrafts(principal: GeoPrincipal, filters: DraftFilters, paging: Paging) {
	assertGeoPermission(principal, "content.read");
	const conditions: SQL[] = [eq(geoContentItems.organizationId, principal.organizationId)];
	if (filters.state) conditions.push(eq(geoContentItems.approvalState, filters.state));
	if (filters.kind) conditions.push(eq(geoContentItems.kind, filters.kind));
	if (filters.taskId) conditions.push(eq(geoContentItems.taskId, filters.taskId));
	const where = and(...conditions);
	const [rows, [{ total }]] = await Promise.all([
		db
			.select({ item: geoContentItems, taskTitle: geoOptimizationTasks.title })
			.from(geoContentItems)
			.leftJoin(geoOptimizationTasks, eq(geoOptimizationTasks.id, geoContentItems.taskId))
			.where(where)
			.orderBy(desc(geoContentItems.updatedAt), desc(geoContentItems.id))
			.limit(paging.limit)
			.offset(paging.offset),
		db.select({ total: count() }).from(geoContentItems).where(where),
	]);
	const names = await displayNames(rows.map((row) => row.item.authorId));
	return {
		rows: rows.map(({ item, taskTitle }) => ({
			id: item.id,
			kind: item.kind,
			title: item.title,
			approvalState: item.approvalState,
			currentVersion: item.currentVersion,
			taskId: item.taskId,
			taskTitle,
			authorName: nameOf(names, item.authorId),
			updatedAt: iso(item.updatedAt) as string,
		})),
		total,
	};
}
export type DraftSummary = Awaited<ReturnType<typeof listDrafts>>["rows"][number];

export async function getDraftDetail(principal: GeoPrincipal, id: string) {
	assertGeoPermission(principal, "content.read");
	const item = await loadItem(db, principal, id);
	const [versions, reviews, publications, task] = await Promise.all([
		db
			.select()
			.from(geoContentVersions)
			.where(eq(geoContentVersions.itemId, item.id))
			.orderBy(desc(geoContentVersions.version)),
		db
			.select()
			.from(geoContentReviews)
			.where(eq(geoContentReviews.itemId, item.id))
			.orderBy(desc(geoContentReviews.createdAt)),
		db
			.select()
			.from(geoPublicationRecords)
			.where(eq(geoPublicationRecords.itemId, item.id))
			.orderBy(desc(geoPublicationRecords.publishedAt)),
		item.taskId
			? db
					.select({ id: geoOptimizationTasks.id, title: geoOptimizationTasks.title, state: geoOptimizationTasks.state })
					.from(geoOptimizationTasks)
					.where(eq(geoOptimizationTasks.id, item.taskId))
					.limit(1)
					.then((rows) => rows[0] ?? null)
			: Promise.resolve(null),
	]);
	const current = versions.find((version) => version.version === item.currentVersion);
	if (!current) throw new GeoError("NOT_FOUND", "草稿版本不存在");
	const live = await releaseProblems(db, principal, current);
	const names = await displayNames([
		item.authorId,
		item.reviewedBy,
		...versions.map((version) => version.createdBy),
		...reviews.map((review) => review.actorId),
		...publications.map((record) => record.recordedBy),
	]);
	return {
		item: {
			id: item.id,
			kind: item.kind,
			title: item.title,
			approvalState: item.approvalState,
			currentVersion: item.currentVersion,
			taskId: item.taskId,
			authorId: item.authorId,
			authorName: nameOf(names, item.authorId),
			reviewNote: item.reviewNote,
			reviewedByName: nameOf(names, item.reviewedBy),
			reviewedAt: iso(item.reviewedAt),
			createdAt: iso(item.createdAt) as string,
			updatedAt: iso(item.updatedAt) as string,
		},
		authorIds: [...new Set([item.authorId, ...versions.map((version) => version.createdBy)])],
		current: {
			version: current.version,
			body: current.body,
			claims: claimsOf(current),
			generator: current.generator,
			model: current.model,
			createdByName: nameOf(names, current.createdBy),
			createdAt: iso(current.createdAt) as string,
			validation: live.validation,
			factProblems: live.factProblems,
		},
		versions: versions.map((version) => {
			const stored = version.validation as StoredValidation | null;
			return {
				version: version.version,
				generator: version.generator,
				model: version.model,
				createdByName: nameOf(names, version.createdBy),
				createdAt: iso(version.createdAt) as string,
				blockingCount: stored?.result.blockingCount ?? null,
				pendingCount: stored?.result.pendingCount ?? null,
			};
		}),
		reviews: reviews.map((review) => ({
			id: review.id,
			version: review.version,
			action: review.action,
			fromState: review.fromState,
			toState: review.toState,
			actorName: nameOf(names, review.actorId),
			comment: review.comment,
			createdAt: iso(review.createdAt) as string,
		})),
		publications: publications.map((record) => ({
			id: record.id,
			version: record.version,
			url: record.url,
			publishedAt: iso(record.publishedAt) as string,
			proof: record.proof as { note: string; url: string | null } | null,
			recordedByName: nameOf(names, record.recordedBy),
		})),
		task,
	};
}
export type DraftDetail = Awaited<ReturnType<typeof getDraftDetail>>;

export async function getDraftVersion(principal: GeoPrincipal, id: string, version: number) {
	assertGeoPermission(principal, "content.read");
	const item = await loadItem(db, principal, id);
	const [row] = await db
		.select()
		.from(geoContentVersions)
		.where(and(eq(geoContentVersions.itemId, item.id), eq(geoContentVersions.version, version)))
		.limit(1);
	if (!row) throw new GeoError("NOT_FOUND", "草稿版本不存在");
	return {
		version: row.version,
		body: row.body,
		claims: claimsOf(row),
		generator: row.generator,
		model: row.model,
		validation: (row.validation as StoredValidation | null)?.result ?? null,
		createdAt: iso(row.createdAt) as string,
	};
}

export async function listDraftTaskChoices(principal: GeoPrincipal) {
	assertGeoPermission(principal, "task.read");
	return db
		.select({ id: geoOptimizationTasks.id, title: geoOptimizationTasks.title, state: geoOptimizationTasks.state })
		.from(geoOptimizationTasks)
		.where(
			and(
				eq(geoOptimizationTasks.organizationId, principal.organizationId),
				notInArray(geoOptimizationTasks.state, ["VERIFIED", "CANCELLED"]),
			),
		)
		.orderBy(desc(geoOptimizationTasks.updatedAt))
		.limit(200);
}

export async function draftLlmStatus(principal: GeoPrincipal) {
	assertGeoPermission(principal, "content.read");
	const [settings] = await db
		.select({ approved: geoOrgSettings.llmUseApproved })
		.from(geoOrgSettings)
		.where(eq(geoOrgSettings.organizationId, principal.organizationId))
		.limit(1);
	return { llmUseApproved: settings?.approved ?? false };
}
