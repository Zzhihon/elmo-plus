import { createHash } from "node:crypto";
import {
	assertGeoPermission,
	claimRiskLevel,
	displayFileName,
	GEO_ASSET_APPROVAL_STATUSES,
	GEO_ASSET_TYPES,
	GEO_KNOWLEDGE_CLAIM_TYPES,
	GEO_KNOWLEDGE_UPLOAD_MAX_BYTES,
	GEO_PUBLICATION_SCOPES,
	GEO_SITE_ENTITY_KINDS,
	GeoError,
	type GeoPrincipal,
	type GeoPublicationScope,
	scopeAllows,
	sniffKnowledgeFile,
} from "@workspace/geo-domain";
import { geoObjectKey, getObjectStore, ScanUnavailableError, scanUpload } from "@workspace/geo-evidence";
import { canonicalKeyOf, normalizeValueText, searchTokensOf } from "@workspace/geo-site-ingestion";
import { db } from "@workspace/lib/db/db";
import type { DbConnection } from "@workspace/lib/db/db-connection";
import {
	geoAssertionSources,
	geoKnowledgeAssertions,
	geoKnowledgeAssets,
	geoSiteEntities,
} from "@workspace/lib/db/schema";
import { writeGeoAudit } from "@workspace/lib/geo/audit";
import { detectAssertionConflicts, sweepKnowledgeValidity } from "@workspace/lib/geo/knowledge";
import { and, count, desc, eq, ilike, inArray, ne, notInArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
	canReadConfidential,
	displayNames,
	iso,
	locatorFields,
	nameOf,
	optionalText,
	type Paging,
	parseValidUntil,
	text,
	validUntilSchema,
} from "./knowledge-shared";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const scopesSchema = z
	.object({
		confidentiality: z.enum(GEO_PUBLICATION_SCOPES),
		publicationScope: z.enum(GEO_PUBLICATION_SCOPES),
	})
	.refine((value) => scopeAllows(value.confidentiality, value.publicationScope), {
		message: "可公开范围不能比资料的保密级别更宽",
		path: ["publicationScope"],
	});

export const assetMetadataSchema = z
	.object({
		title: text(200).min(1, "请填写资料名称"),
		assetType: z.enum(GEO_ASSET_TYPES),
		description: optionalText(2000),
		sourceUri: z.string().trim().url().max(2000).nullish(),
		validUntil: validUntilSchema,
	})
	.and(scopesSchema);
export type AssetMetadata = z.infer<typeof assetMetadataSchema>;

export const assetUpdateSchema = z.object({
	title: text(200).min(1).optional(),
	description: optionalText(2000),
	validUntil: validUntilSchema,
});
export type AssetUpdate = z.infer<typeof assetUpdateSchema>;

export const assetReviewSchema = z.object({
	decision: z.enum(["APPROVE", "REJECT"]),
	note: text(2000).min(1, "请填写审核依据"),
});
export type AssetReviewInput = z.infer<typeof assetReviewSchema>;

export const assetFiltersSchema = z.object({
	q: z.string().trim().max(200).optional(),
	assetType: z.enum(GEO_ASSET_TYPES).optional(),
	approvalStatus: z.enum(GEO_ASSET_APPROVAL_STATUSES).optional(),
});
export type AssetFilters = z.infer<typeof assetFiltersSchema>;

const locatorSchema = z
	.object({
		page: z.number().int().min(1).max(100_000).nullish(),
		paragraph: optionalText(200),
		section: optionalText(200),
		quote: optionalText(2000),
	})
	.refine((value) => value.page || value.paragraph || value.section, {
		message: "请至少填写页码、段落或章节中的一项",
	});

export const registerClaimSchema = z.object({
	entity: z.union([
		z.object({ id: z.string().uuid() }),
		z.object({ kind: z.enum(GEO_SITE_ENTITY_KINDS), title: text(200).min(1) }),
	]),
	claimType: z.enum(GEO_KNOWLEDGE_CLAIM_TYPES),
	fieldPath: text(200)
		.min(1)
		.regex(/^[A-Za-z0-9_.\-\p{Script=Han}]+$/u, "字段路径只能包含字母、数字、汉字和 . _ -"),
	claimText: text(2000).min(1),
	value: optionalText(2000),
	locator: locatorSchema,
	validUntil: validUntilSchema,
});
export type RegisterClaimInput = z.infer<typeof registerClaimSchema>;

export const attachSourceSchema = z.object({ assetId: z.string().uuid(), locator: locatorSchema });
export type AttachSourceInput = z.infer<typeof attachSourceSchema>;

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

type AssetRow = typeof geoKnowledgeAssets.$inferSelect;

function assetView(row: AssetRow, names: Record<string, string>, now = new Date()) {
	return {
		id: row.id,
		title: row.title,
		assetType: row.assetType,
		description: row.description,
		fileName: row.fileName,
		sourceUri: row.sourceUri,
		mime: row.mime,
		size: row.size,
		sha256: row.sha256,
		scanStatus: row.scanStatus,
		approvalStatus: row.approvalStatus,
		validUntil: iso(row.validUntil),
		expired: Boolean(row.validUntil && row.validUntil.getTime() <= now.getTime()),
		publicationScope: row.publicationScope,
		confidentiality: row.confidentiality,
		uploadedBy: row.uploadedBy,
		uploadedByName: nameOf(names, row.uploadedBy),
		reviewNote: row.reviewNote,
		reviewedBy: row.reviewedBy,
		reviewedByName: nameOf(names, row.reviewedBy),
		reviewedAt: iso(row.reviewedAt),
		createdAt: iso(row.createdAt) as string,
	};
}
export type KnowledgeAssetView = ReturnType<typeof assetView>;

function visibleAssets(principal: GeoPrincipal) {
	const own = eq(geoKnowledgeAssets.organizationId, principal.organizationId);
	return canReadConfidential(principal) ? own : and(own, ne(geoKnowledgeAssets.confidentiality, "CONFIDENTIAL"));
}

export async function loadAsset(tx: DbConnection, principal: GeoPrincipal, assetId: string): Promise<AssetRow> {
	const [row] = await tx
		.select()
		.from(geoKnowledgeAssets)
		.where(and(visibleAssets(principal), eq(geoKnowledgeAssets.id, assetId)))
		.limit(1);
	if (!row) throw new GeoError("NOT_FOUND", "资料不存在");
	return row;
}

// ---------------------------------------------------------------------------
// Upload, list, read
// ---------------------------------------------------------------------------

/**
 * The object key is the content hash, so a user-supplied name never reaches
 * storage and the same file uploaded twice is one asset. Infected files are
 * never stored; a configured scanner that cannot be reached refuses the upload.
 */
export async function uploadKnowledgeAsset(
	principal: GeoPrincipal,
	file: File,
	metadata: AssetMetadata,
): Promise<{ asset: KnowledgeAssetView; created: boolean }> {
	assertGeoPermission(principal, "knowledge.write");
	if (file.size === 0) throw new GeoError("VALIDATION_ERROR", "文件为空");
	if (file.size > GEO_KNOWLEDGE_UPLOAD_MAX_BYTES) {
		throw new GeoError("VALIDATION_ERROR", `文件不能超过 ${GEO_KNOWLEDGE_UPLOAD_MAX_BYTES / 1024 / 1024} MB`);
	}
	const bytes = new Uint8Array(await file.arrayBuffer());
	const type = sniffKnowledgeFile(bytes, file.name);
	if (!type) throw new GeoError("VALIDATION_ERROR", "只支持 PDF、Word（doc/docx）、PNG、JPEG、WebP 文件");
	const sha256 = createHash("sha256").update(bytes).digest("hex");

	const [existing] = await db
		.select()
		.from(geoKnowledgeAssets)
		.where(and(eq(geoKnowledgeAssets.organizationId, principal.organizationId), eq(geoKnowledgeAssets.sha256, sha256)))
		.limit(1);
	if (existing) {
		if (existing.confidentiality === "CONFIDENTIAL" && !canReadConfidential(principal)) {
			throw new GeoError("CONFLICT", "相同的文件已经上传过");
		}
		const names = await displayNames([existing.uploadedBy, existing.reviewedBy]);
		return { asset: assetView(existing, names), created: false };
	}

	let scan: Awaited<ReturnType<typeof scanUpload>>;
	try {
		scan = await scanUpload(bytes);
	} catch (error) {
		if (error instanceof ScanUnavailableError) {
			throw new GeoError("TARGET_UNAVAILABLE", "恶意文件扫描服务不可用，请稍后重试", { cause: error });
		}
		throw error;
	}
	if (scan.status === "INFECTED") {
		await writeGeoAudit(db, {
			principal,
			action: "knowledge.asset.infected",
			entityType: "knowledge_asset_upload",
			entityId: sha256,
			metadata: { signature: scan.signature, size: bytes.length, mime: type.mime },
		});
		throw new GeoError("VALIDATION_ERROR", "文件未通过恶意文件扫描，已拒绝上传");
	}

	const objectKey = geoObjectKey(principal.organizationId, "knowledge", `${sha256}.${type.ext}`);
	await getObjectStore().put(objectKey, bytes, { contentType: type.mime });

	const row = await db.transaction(async (tx) => {
		await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`geo-asset:${principal.organizationId}:${sha256}`}))`);
		const [again] = await tx
			.select()
			.from(geoKnowledgeAssets)
			.where(
				and(eq(geoKnowledgeAssets.organizationId, principal.organizationId), eq(geoKnowledgeAssets.sha256, sha256)),
			)
			.limit(1);
		if (again) return { row: again, created: false };
		const [inserted] = await tx
			.insert(geoKnowledgeAssets)
			.values({
				organizationId: principal.organizationId,
				assetType: metadata.assetType,
				title: metadata.title,
				description: metadata.description ?? null,
				sourceUri: metadata.sourceUri ?? null,
				fileName: displayFileName(file.name),
				objectKey,
				mime: type.mime,
				size: bytes.length,
				sha256,
				scanStatus: scan.status,
				approvalStatus: "PENDING",
				validUntil: parseValidUntil(metadata.validUntil),
				publicationScope: metadata.publicationScope,
				confidentiality: metadata.confidentiality,
				uploadedBy: principal.actorId,
			})
			.returning();
		await writeGeoAudit(tx, {
			principal,
			action: "knowledge.asset.upload",
			entityType: "knowledge_asset",
			entityId: inserted.id,
			after: inserted,
			metadata: { scan: scan.status, mime: type.mime, size: bytes.length },
		});
		return { row: inserted, created: true };
	});
	const names = await displayNames([row.row.uploadedBy]);
	return { asset: assetView(row.row, names), created: row.created };
}

export async function listKnowledgeAssets(principal: GeoPrincipal, filters: AssetFilters, paging: Paging) {
	assertGeoPermission(principal, "knowledge.read");
	const conditions = [visibleAssets(principal)];
	if (filters.assetType) conditions.push(eq(geoKnowledgeAssets.assetType, filters.assetType));
	if (filters.approvalStatus) conditions.push(eq(geoKnowledgeAssets.approvalStatus, filters.approvalStatus));
	if (filters.q) {
		const pattern = `%${filters.q.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
		const match = or(ilike(geoKnowledgeAssets.title, pattern), ilike(geoKnowledgeAssets.fileName, pattern));
		if (match) conditions.push(match);
	}
	const where = and(...conditions);
	const claimCount = sql<number>`(
		select count(distinct ${geoAssertionSources.assertionId})::int from ${geoAssertionSources}
		where ${geoAssertionSources.assetId} = ${geoKnowledgeAssets.id}
	)`;
	const [rows, [{ total }]] = await Promise.all([
		db
			.select({ asset: geoKnowledgeAssets, claimCount })
			.from(geoKnowledgeAssets)
			.where(where)
			.orderBy(desc(geoKnowledgeAssets.createdAt), desc(geoKnowledgeAssets.id))
			.limit(paging.limit)
			.offset(paging.offset),
		db.select({ total: count() }).from(geoKnowledgeAssets).where(where),
	]);
	const names = await displayNames(rows.flatMap((row) => [row.asset.uploadedBy, row.asset.reviewedBy]));
	return {
		rows: rows.map((row) => ({ ...assetView(row.asset, names), claimCount: Number(row.claimCount) })),
		total,
	};
}

export async function getKnowledgeAsset(principal: GeoPrincipal, assetId: string) {
	assertGeoPermission(principal, "knowledge.read");
	const asset = await loadAsset(db, principal, assetId);
	const claims = await db
		.selectDistinctOn([geoKnowledgeAssertions.id], {
			id: geoKnowledgeAssertions.id,
			claimType: geoKnowledgeAssertions.claimType,
			fieldPath: geoKnowledgeAssertions.fieldPath,
			claimText: geoKnowledgeAssertions.claimText,
			status: geoKnowledgeAssertions.status,
			riskLevel: geoKnowledgeAssertions.riskLevel,
			publicationScope: geoKnowledgeAssertions.publicationScope,
			entityTitle: geoSiteEntities.title,
			entityKind: geoSiteEntities.kind,
			locator: geoAssertionSources.locator,
		})
		.from(geoAssertionSources)
		.innerJoin(geoKnowledgeAssertions, eq(geoKnowledgeAssertions.id, geoAssertionSources.assertionId))
		.leftJoin(geoSiteEntities, eq(geoSiteEntities.id, geoKnowledgeAssertions.entityId))
		.where(
			and(eq(geoAssertionSources.organizationId, principal.organizationId), eq(geoAssertionSources.assetId, asset.id)),
		)
		.orderBy(geoKnowledgeAssertions.id);
	const names = await displayNames([asset.uploadedBy, asset.reviewedBy]);
	return {
		asset: assetView(asset, names),
		claims: claims.map((claim) => ({ ...claim, locator: locatorFields(claim.locator) })),
	};
}

export async function updateKnowledgeAsset(principal: GeoPrincipal, assetId: string, input: AssetUpdate) {
	assertGeoPermission(principal, "knowledge.write");
	return db.transaction(async (tx) => {
		const before = await loadAsset(tx, principal, assetId);
		const patch: Partial<AssetRow> = {};
		if (input.title !== undefined) patch.title = input.title;
		if (input.description !== undefined) patch.description = input.description ?? null;
		if (input.validUntil !== undefined) patch.validUntil = parseValidUntil(input.validUntil);
		if (Object.keys(patch).length === 0) return before;
		const [after] = await tx
			.update(geoKnowledgeAssets)
			.set(patch)
			.where(eq(geoKnowledgeAssets.id, before.id))
			.returning();
		await writeGeoAudit(tx, {
			principal,
			action: "knowledge.asset.update",
			entityType: "knowledge_asset",
			entityId: before.id,
			before,
			after,
		});
		if (patch.validUntil !== undefined) await sweepKnowledgeValidity(tx, principal.organizationId);
		return after;
	});
}

/** A reviewer confirms the document is genuine and current; only then does it count as an original. */
export async function reviewKnowledgeAsset(principal: GeoPrincipal, assetId: string, input: AssetReviewInput) {
	assertGeoPermission(principal, "knowledge.review");
	return db.transaction(async (tx) => {
		const before = await loadAsset(tx, principal, assetId);
		if (input.decision === "APPROVE" && before.uploadedBy === principal.actorId) {
			throw new GeoError("FORBIDDEN", "上传人不能确认自己上传的资料");
		}
		if (input.decision === "APPROVE" && before.scanStatus === "PENDING") {
			throw new GeoError("CONFLICT", "资料尚未完成扫描");
		}
		const status = input.decision === "APPROVE" ? "APPROVED" : "REJECTED";
		const [after] = await tx
			.update(geoKnowledgeAssets)
			.set({ approvalStatus: status, reviewNote: input.note, reviewedBy: principal.actorId, reviewedAt: new Date() })
			.where(eq(geoKnowledgeAssets.id, before.id))
			.returning();
		await writeGeoAudit(tx, {
			principal,
			action: `knowledge.asset.${status === "APPROVED" ? "approve" : "reject"}`,
			entityType: "knowledge_asset",
			entityId: before.id,
			before: { approvalStatus: before.approvalStatus },
			after: { approvalStatus: status },
			metadata: { note: input.note },
		});
		if (status === "REJECTED") await sweepKnowledgeValidity(tx, principal.organizationId);
		return after;
	});
}

/** The original only ever leaves through this function, with the access written to the audit log. */
export async function downloadKnowledgeAsset(principal: GeoPrincipal, assetId: string): Promise<Response> {
	assertGeoPermission(principal, "knowledge.read");
	const asset = await loadAsset(db, principal, assetId);
	if (!asset.objectKey) throw new GeoError("NOT_FOUND", "该资料没有原件文件");
	const object = await getObjectStore().get(asset.objectKey);
	if (!object) throw new GeoError("NOT_FOUND", "原件文件不存在");
	await writeGeoAudit(db, {
		principal,
		action: "knowledge.asset.download",
		entityType: "knowledge_asset",
		entityId: asset.id,
		metadata: { size: object.size, confidentiality: asset.confidentiality },
	});
	const extension = asset.objectKey.split(".").pop() ?? "bin";
	const display = encodeURIComponent(asset.fileName ?? `${asset.title}.${extension}`);
	return new Response(new Uint8Array(object.body), {
		headers: {
			"Content-Type": asset.mime ?? "application/octet-stream",
			"Content-Disposition": `attachment; filename="asset-${asset.id}.${extension}"; filename*=UTF-8''${display}`,
			"Content-Security-Policy": "sandbox; default-src 'none'",
			"X-Content-Type-Options": "nosniff",
			"Cache-Control": "private, no-store",
		},
	});
}

// ---------------------------------------------------------------------------
// Claims entered on an original
// ---------------------------------------------------------------------------

function assetLocator(assetId: string, locator: RegisterClaimInput["locator"]) {
	return {
		assetId,
		page: locator.page ?? null,
		paragraph: locator.paragraph ?? null,
		section: locator.section ?? null,
		quote: locator.quote ?? null,
	};
}

function usableForClaims(asset: AssetRow) {
	if (asset.approvalStatus === "REJECTED") throw new GeoError("CONFLICT", "资料已被驳回，不能作为来源");
	if (asset.scanStatus === "INFECTED" || asset.scanStatus === "PENDING") {
		throw new GeoError("CONFLICT", "资料未通过扫描，不能作为来源");
	}
}

async function resolveEntity(tx: DbConnection, principal: GeoPrincipal, entity: RegisterClaimInput["entity"]) {
	if ("id" in entity) {
		const [row] = await tx
			.select({ id: geoSiteEntities.id, title: geoSiteEntities.title })
			.from(geoSiteEntities)
			.where(and(eq(geoSiteEntities.organizationId, principal.organizationId), eq(geoSiteEntities.id, entity.id)))
			.limit(1);
		if (!row) throw new GeoError("NOT_FOUND", "实体不存在");
		return row;
	}
	const title = normalizeValueText(entity.title);
	const canonicalKey = canonicalKeyOf(title);
	if (!canonicalKey) throw new GeoError("VALIDATION_ERROR", "实体名称无效");
	const [created] = await tx
		.insert(geoSiteEntities)
		.values({ organizationId: principal.organizationId, kind: entity.kind, canonicalKey, title, status: "CANDIDATE" })
		.onConflictDoNothing()
		.returning({ id: geoSiteEntities.id, title: geoSiteEntities.title });
	if (created) {
		await writeGeoAudit(tx, {
			principal,
			action: "knowledge.entity.create",
			entityType: "site_entity",
			entityId: created.id,
			after: { kind: entity.kind, canonicalKey, title },
		});
		return created;
	}
	const [existing] = await tx
		.select({ id: geoSiteEntities.id, title: geoSiteEntities.title })
		.from(geoSiteEntities)
		.where(
			and(
				eq(geoSiteEntities.organizationId, principal.organizationId),
				eq(geoSiteEntities.kind, entity.kind),
				eq(geoSiteEntities.canonicalKey, canonicalKey),
			),
		)
		.limit(1);
	return existing;
}

/**
 * A reviewer records a claim found in a customer original, with page and
 * paragraph. It lands on the same entity as the website's claims, so one model
 * gathers its web pages and its manual; the same value only gains a source.
 */
export async function registerAssetClaim(principal: GeoPrincipal, assetId: string, input: RegisterClaimInput) {
	assertGeoPermission(principal, "knowledge.write");
	return db.transaction(async (tx) => {
		const asset = await loadAsset(tx, principal, assetId);
		usableForClaims(asset);
		const entity = await resolveEntity(tx, principal, input.entity);
		const value = normalizeValueText(input.value || input.claimText);
		await tx.execute(
			sql`select pg_advisory_xact_lock(hashtext(${`geo-claim:${entity.id}:${input.fieldPath}:${input.claimType}`}))`,
		);
		const [same] = await tx
			.select({ id: geoKnowledgeAssertions.id, status: geoKnowledgeAssertions.status })
			.from(geoKnowledgeAssertions)
			.where(
				and(
					eq(geoKnowledgeAssertions.organizationId, principal.organizationId),
					eq(geoKnowledgeAssertions.entityId, entity.id),
					eq(geoKnowledgeAssertions.fieldPath, input.fieldPath),
					eq(geoKnowledgeAssertions.claimType, input.claimType),
					sql`${geoKnowledgeAssertions.normalizedValue} = ${JSON.stringify(value)}::jsonb`,
					notInArray(geoKnowledgeAssertions.status, ["REJECTED", "SUPERSEDED"]),
				),
			)
			.limit(1);

		let assertionId = same?.id;
		if (!assertionId) {
			const scope: GeoPublicationScope = asset.confidentiality === "CONFIDENTIAL" ? "CONFIDENTIAL" : "INTERNAL";
			const [created] = await tx
				.insert(geoKnowledgeAssertions)
				.values({
					organizationId: principal.organizationId,
					entityId: entity.id,
					claimType: input.claimType,
					fieldPath: input.fieldPath,
					claimText: input.claimText,
					normalizedValue: value,
					riskLevel: claimRiskLevel(input.claimType, `${input.claimText} ${value}`),
					status: "PENDING_REVIEW",
					publicationScope: scope,
					validUntil: parseValidUntil(input.validUntil),
					searchTokens: searchTokensOf(`${entity.title} ${input.claimText} ${value}`),
					authorId: principal.actorId,
				})
				.returning();
			assertionId = created.id;
			await writeGeoAudit(tx, {
				principal,
				action: "knowledge.assertion.create",
				entityType: "knowledge_assertion",
				entityId: created.id,
				after: created,
				metadata: { assetId: asset.id },
			});
		}
		await tx.insert(geoAssertionSources).values({
			organizationId: principal.organizationId,
			assertionId,
			sourceKind: "ASSET",
			assetId: asset.id,
			locator: assetLocator(asset.id, input.locator),
			extractedAt: new Date(),
		});
		await writeGeoAudit(tx, {
			principal,
			action: "knowledge.assertion.source_add",
			entityType: "knowledge_assertion",
			entityId: assertionId,
			metadata: { assetId: asset.id, page: input.locator.page ?? null },
		});
		const conflicts = await detectAssertionConflicts(tx, principal, { assertionIds: [assertionId] });
		return { assertionId, created: !same, entityId: entity.id, conflicts: conflicts.length };
	});
}

/** Binds a customer original to a claim the website produced, which a high-risk approval needs. */
export async function attachAssetSource(principal: GeoPrincipal, assertionId: string, input: AttachSourceInput) {
	assertGeoPermission(principal, "knowledge.write");
	return db.transaction(async (tx) => {
		const [assertion] = await tx
			.select({ id: geoKnowledgeAssertions.id, status: geoKnowledgeAssertions.status })
			.from(geoKnowledgeAssertions)
			.where(
				and(
					eq(geoKnowledgeAssertions.organizationId, principal.organizationId),
					eq(geoKnowledgeAssertions.id, assertionId),
				),
			)
			.limit(1);
		if (!assertion) throw new GeoError("NOT_FOUND", "断言不存在");
		if (assertion.status === "SUPERSEDED") throw new GeoError("CONFLICT", "已被替代的断言不能再添加来源");
		const asset = await loadAsset(tx, principal, input.assetId);
		usableForClaims(asset);
		const [source] = await tx
			.insert(geoAssertionSources)
			.values({
				organizationId: principal.organizationId,
				assertionId: assertion.id,
				sourceKind: "ASSET",
				assetId: asset.id,
				locator: assetLocator(asset.id, input.locator),
				extractedAt: new Date(),
			})
			.returning({ id: geoAssertionSources.id });
		await writeGeoAudit(tx, {
			principal,
			action: "knowledge.assertion.source_add",
			entityType: "knowledge_assertion",
			entityId: assertion.id,
			metadata: { assetId: asset.id, sourceId: source.id, page: input.locator.page ?? null },
		});
		return { sourceId: source.id };
	});
}

export async function listAssetChoices(principal: GeoPrincipal) {
	assertGeoPermission(principal, "knowledge.read");
	return db
		.select({
			id: geoKnowledgeAssets.id,
			title: geoKnowledgeAssets.title,
			assetType: geoKnowledgeAssets.assetType,
			approvalStatus: geoKnowledgeAssets.approvalStatus,
			validUntil: geoKnowledgeAssets.validUntil,
		})
		.from(geoKnowledgeAssets)
		.where(
			and(
				visibleAssets(principal),
				inArray(geoKnowledgeAssets.approvalStatus, ["PENDING", "APPROVED"]),
				inArray(geoKnowledgeAssets.scanStatus, ["CLEAN", "UNSCANNED"]),
			),
		)
		.orderBy(desc(geoKnowledgeAssets.createdAt))
		.limit(200)
		.then((rows) => rows.map((row) => ({ ...row, validUntil: iso(row.validUntil) })));
}

/** The upload routes take the file and its metadata as one multipart form. */
export async function readAssetUpload(request: Request): Promise<{ file: File; metadata: AssetMetadata }> {
	const form = await request.formData().catch(() => null);
	const file = form?.get("file");
	if (!form || !(file instanceof File)) throw new GeoError("VALIDATION_ERROR", "请选择要上传的文件");
	const field = (name: string) => {
		const value = form.get(name);
		return typeof value === "string" && value.trim() ? value.trim() : null;
	};
	const parsed = assetMetadataSchema.safeParse({
		title: field("title") ?? displayFileName(file.name),
		assetType: field("assetType"),
		description: field("description"),
		sourceUri: field("sourceUri"),
		validUntil: field("validUntil"),
		confidentiality: field("confidentiality") ?? "INTERNAL",
		publicationScope: field("publicationScope") ?? "INTERNAL",
	});
	if (!parsed.success) {
		throw new GeoError("VALIDATION_ERROR", parsed.error.issues.map((issue) => issue.message).join("；"));
	}
	return { file, metadata: parsed.data };
}
