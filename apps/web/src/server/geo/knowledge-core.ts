import {
	assertGeoPermission,
	assertGeoTransition,
	assertionTransition,
	canonicalClaimValue,
	effectiveRiskLevel,
	effectiveValidUntil,
	factBlockers,
	GEO_ASSERTION_STATUSES,
	GEO_HIGH_RISK_CLAIM_TYPES,
	GEO_KNOWLEDGE_CLAIM_TYPES,
	GEO_PUBLICATION_SCOPES,
	GEO_RISK_LEVELS,
	GEO_SITE_ENTITY_KINDS,
	type GeoAssertionAction,
	type GeoAssertionStatus,
	GeoError,
	type GeoPrincipal,
	type GeoPublicationScope,
	hasValidOriginalDocument,
	knowledgeApprovalProblem,
	transitionActorOf,
	widestPublicationScope,
} from "@workspace/geo-domain";
import { searchTokensOf } from "@workspace/geo-site-ingestion";
import { db } from "@workspace/lib/db/db";
import type { DbConnection } from "@workspace/lib/db/db-connection";
import {
	geoAssertionConflicts,
	geoAssertionReviews,
	geoAssertionSources,
	geoKnowledgeAssertions,
	geoKnowledgeAssets,
	geoOptimizationTasks,
	geoSiteEntities,
	geoSiteEntitySources,
	geoSitePageVersions,
	geoTaskEvidence,
} from "@workspace/lib/db/schema";
import { writeGeoAudit } from "@workspace/lib/geo/audit";
import {
	closeAssertionConflicts,
	detectAssertionConflicts,
	type GeoAssertionSourceRow,
	loadAssertionSources,
	loadFactStates,
	lockClaimField,
} from "@workspace/lib/geo/knowledge";
import {
	aliasedTable,
	and,
	asc,
	count,
	desc,
	eq,
	getTableName,
	ilike,
	inArray,
	isNull,
	ne,
	notInArray,
	or,
	type SQL,
	sql,
} from "drizzle-orm";
import { z } from "zod";
import {
	canReadConfidential,
	displayNames,
	iso,
	knowledgeValue,
	hiddenFromReader,
	type LocatorFields,
	locatorFields,
	nameOf,
	type Paging,
	parseValidUntil,
	text,
	validUntilSchema,
} from "./knowledge-shared";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const CLAIM_REVIEW_DECISIONS = [
	"APPROVE",
	"REJECT",
	"REQUEST_EVIDENCE",
	"INVALIDATE",
	"RESUBMIT",
	"FREEZE",
	"UNFREEZE",
] as const;
export type ClaimReviewDecision = (typeof CLAIM_REVIEW_DECISIONS)[number];

export const claimReviewSchema = z.object({
	decision: z.enum(CLAIM_REVIEW_DECISIONS),
	basis: text(4000).min(1, "请填写审核依据"),
	publicationScope: z.enum(GEO_PUBLICATION_SCOPES).nullish(),
	validUntil: validUntilSchema,
});
export type ClaimReviewInput = z.infer<typeof claimReviewSchema>;

export const conflictResolutionSchema = z.object({
	resolution: z.enum(["KEEP_APPROVED", "ACCEPT_CANDIDATE"]),
	basis: text(4000).min(1, "请填写处理依据"),
	publicationScope: z.enum(GEO_PUBLICATION_SCOPES).nullish(),
	validUntil: validUntilSchema,
});
export type ConflictResolutionInput = z.infer<typeof conflictResolutionSchema>;

const booleanParam = z
	.union([z.boolean(), z.enum(["true", "false"])])
	.transform((value) => value === true || value === "true");

export const claimFiltersSchema = z.object({
	q: z.string().trim().max(200).optional(),
	/** true: approved facts only; false: everything not yet approved. */
	verified: booleanParam.optional(),
	status: z.array(z.enum(GEO_ASSERTION_STATUSES)).optional(),
	entityKind: z.enum(GEO_SITE_ENTITY_KINDS).optional(),
	entityId: z.string().uuid().optional(),
	claimType: z.enum(GEO_KNOWLEDGE_CLAIM_TYPES).optional(),
	riskLevel: z.enum(GEO_RISK_LEVELS).optional(),
	sourceKind: z.enum(["PAGE_VERSION", "ASSET"]).optional(),
	publicationScope: z.enum(GEO_PUBLICATION_SCOPES).optional(),
	frozen: booleanParam.optional(),
	hasConflict: booleanParam.optional(),
});
export type ClaimFilters = z.infer<typeof claimFiltersSchema>;

/** The REST form: `status` arrives as a comma-separated list. */
export const claimListQuerySchema = claimFiltersSchema.extend({
	status: z
		.string()
		.optional()
		.transform((value) => (value ? value.split(",") : undefined))
		.pipe(z.array(z.enum(GEO_ASSERTION_STATUSES)).optional()),
});

export const conflictFiltersSchema = z.object({ status: z.enum(["OPEN", "RESOLVED"]).optional() });

export const entitySearchSchema = z.object({
	q: z.string().trim().max(200).optional(),
	kind: z.enum(GEO_SITE_ENTITY_KINDS).optional(),
});

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

type AssertionRow = typeof geoKnowledgeAssertions.$inferSelect;

const PENDING_STATUSES: readonly GeoAssertionStatus[] = ["PENDING_REVIEW", "NEEDS_EVIDENCE", "SOURCE_UNAVAILABLE"];

function textField(fields: LocatorFields, key: string): string | null {
	const value = fields[key];
	return typeof value === "string" ? value : null;
}

function pageCitation(source: GeoAssertionSourceRow) {
	const locator = locatorFields(source.locator);
	return {
		kind: "PAGE_VERSION" as const,
		id: source.id,
		pageId: source.pageId,
		pageVersionId: source.pageVersionId,
		url: source.url ?? textField(locator, "url"),
		pageStatus: source.pageStatus ?? null,
		fieldPath: textField(locator, "fieldPath"),
		selector: textField(locator, "selector"),
		quote: textField(locator, "quote"),
		parserVersion: source.parserVersion,
		extractedAt: iso(source.extractedAt),
		hidden: false,
	};
}

function assetCitation(source: GeoAssertionSourceRow, showConfidential: boolean) {
	const hidden = source.assetConfidentiality === "CONFIDENTIAL" && !showConfidential;
	const locator = hidden ? {} : locatorFields(source.locator);
	return {
		kind: "ASSET" as const,
		id: source.id,
		assetId: hidden ? null : source.assetId,
		assetTitle: hidden ? null : source.assetTitle,
		assetApproval: source.assetApproval ?? null,
		assetValidUntil: iso(source.assetValidUntil),
		page: typeof locator.page === "number" ? locator.page : null,
		paragraph: textField(locator, "paragraph"),
		section: textField(locator, "section"),
		quote: textField(locator, "quote"),
		extractedAt: iso(source.extractedAt),
		hidden,
	};
}

/**
 * A citation a reader can follow: the page version and field for website
 * sources, the document and page for originals. Confidential documents are
 * counted but not described to someone who may not read them.
 */
function citationView(source: GeoAssertionSourceRow, showConfidential: boolean) {
	return source.kind === "PAGE_VERSION" ? pageCitation(source) : assetCitation(source, showConfidential);
}
export type KnowledgeCitation = ReturnType<typeof citationView>;

function claimView(
	row: AssertionRow,
	entity: { id: string; kind: string; title: string } | null,
	sources: GeoAssertionSourceRow[],
	extra: { openConflicts: number; showConfidential: boolean; now?: Date },
) {
	const now = extra.now ?? new Date();
	const blockers = factBlockers(
		{
			status: row.status,
			publicationScope: row.publicationScope,
			validUntil: row.validUntil,
			frozen: row.frozenAt !== null,
			openConflicts: extra.openConflicts,
		},
		now,
	);
	const approved = row.status === "APPROVED" && !blockers.includes("EXPIRED");
	return {
		id: row.id,
		/** Never blur the two: a reviewed fact, or something a page or document says that nobody has confirmed. */
		evidenceClass: approved ? ("APPROVED_FACT" as const) : ("UNREVIEWED" as const),
		claimType: row.claimType,
		fieldPath: row.fieldPath,
		claimText: row.claimText,
		normalizedValue: knowledgeValue(row.normalizedValue),
		status: row.status,
		riskLevel: effectiveRiskLevel(row),
		publicationScope: row.publicationScope,
		validUntil: iso(row.validUntil),
		expired: blockers.includes("EXPIRED"),
		frozen: row.frozenAt !== null,
		frozenReason: row.frozenReason,
		frozenAt: iso(row.frozenAt),
		supersededBy: row.supersededBy,
		authorId: row.authorId,
		openConflicts: extra.openConflicts,
		publicBlockers: blockers,
		entity,
		citations: sources.map((source) => citationView(source, extra.showConfidential)),
		createdAt: iso(row.createdAt) as string,
		updatedAt: iso(row.updatedAt) as string,
	};
}
export type KnowledgeClaimView = ReturnType<typeof claimView>;

function visibleClaims(principal: GeoPrincipal): SQL {
	const own = eq(geoKnowledgeAssertions.organizationId, principal.organizationId);
	return canReadConfidential(principal)
		? own
		: (and(own, ne(geoKnowledgeAssertions.publicationScope, "CONFIDENTIAL")) as SQL);
}

const openConflictCount = sql<number>`(
	select count(*)::int from ${geoAssertionConflicts}
	where ${geoAssertionConflicts.status} = 'OPEN'
	and (${geoAssertionConflicts.candidateId} = ${geoKnowledgeAssertions.id}
		or ${geoAssertionConflicts.approvedId} = ${geoKnowledgeAssertions.id})
)`;

async function hydrateClaims(
	principal: GeoPrincipal,
	rows: {
		assertion: AssertionRow;
		entity: { id: string; kind: string; title: string } | null;
		openConflicts: number;
	}[],
) {
	const sources = await loadAssertionSources(
		db,
		principal.organizationId,
		rows.map((row) => row.assertion.id),
	);
	const showConfidential = canReadConfidential(principal);
	return rows.map((row) =>
		claimView(row.assertion, row.entity, sources.get(row.assertion.id) ?? [], {
			openConflicts: Number(row.openConflicts),
			showConfidential,
		}),
	);
}

function entityColumns() {
	return sql<{ id: string; kind: string; title: string } | null>`case when ${geoSiteEntities.id} is null then null
		else json_build_object('id', ${geoSiteEntities.id}, 'kind', ${geoSiteEntities.kind}, 'title', ${geoSiteEntities.title}) end`;
}

// ---------------------------------------------------------------------------
// Search and list
// ---------------------------------------------------------------------------

const inDate = sql`(${geoKnowledgeAssertions.validUntil} is null or ${geoKnowledgeAssertions.validUntil} > now())`;
const highRisk = sql`(${geoKnowledgeAssertions.riskLevel} = 'HIGH' or ${inArray(geoKnowledgeAssertions.claimType, [...GEO_HIGH_RISK_CLAIM_TYPES])})`;

function reviewConditions(filters: ClaimFilters): SQL[] {
	const conditions: SQL[] = [];
	if (filters.verified === true) conditions.push(eq(geoKnowledgeAssertions.status, "APPROVED"), inDate);
	if (filters.verified === false) {
		conditions.push(
			sql`not (${geoKnowledgeAssertions.status} = 'APPROVED' and ${inDate})`,
			notInArray(geoKnowledgeAssertions.status, ["REJECTED", "SUPERSEDED"]),
		);
	}
	if (filters.status?.length) conditions.push(inArray(geoKnowledgeAssertions.status, filters.status));
	if (filters.riskLevel) conditions.push(filters.riskLevel === "HIGH" ? highRisk : sql`not ${highRisk}`);
	if (filters.frozen !== undefined) {
		conditions.push(sql`${geoKnowledgeAssertions.frozenAt} is ${filters.frozen ? sql`not null` : sql`null`}`);
	}
	if (filters.hasConflict !== undefined) {
		conditions.push(sql`${openConflictCount} ${filters.hasConflict ? sql`>` : sql`=`} 0`);
	}
	return conditions;
}

function attributeConditions(filters: ClaimFilters): SQL[] {
	const conditions: SQL[] = [];
	if (filters.entityKind) conditions.push(eq(geoSiteEntities.kind, filters.entityKind));
	if (filters.entityId) conditions.push(eq(geoKnowledgeAssertions.entityId, filters.entityId));
	if (filters.claimType) conditions.push(eq(geoKnowledgeAssertions.claimType, filters.claimType));
	if (filters.publicationScope) conditions.push(eq(geoKnowledgeAssertions.publicationScope, filters.publicationScope));
	if (filters.sourceKind) {
		conditions.push(sql`exists (
			select 1 from ${geoAssertionSources}
			where ${geoAssertionSources.assertionId} = ${geoKnowledgeAssertions.id}
			and ${geoAssertionSources.sourceKind} = ${filters.sourceKind}
		)`);
	}
	return conditions;
}

/**
 * Keyword search over the same CJK-bigram tokens the writers store, so the
 * query matches the GIN index expression, plus structured filters.
 */
export async function searchClaims(principal: GeoPrincipal, filters: ClaimFilters, paging: Paging) {
	assertGeoPermission(principal, "knowledge.read");
	const conditions: SQL[] = [visibleClaims(principal), ...reviewConditions(filters), ...attributeConditions(filters)];
	let rank: SQL | null = null;
	if (filters.q) {
		const tokens = searchTokensOf(filters.q);
		if (!tokens) return { rows: [], total: 0 };
		const query = sql`plainto_tsquery('simple', ${tokens})`;
		conditions.push(sql`to_tsvector('simple', ${geoKnowledgeAssertions.searchTokens}) @@ ${query}`);
		rank = sql`ts_rank(to_tsvector('simple', ${geoKnowledgeAssertions.searchTokens}), ${query})`;
	}

	const where = and(...conditions);
	const order = [
		...(rank ? [desc(rank)] : []),
		desc(sql`case when ${geoKnowledgeAssertions.riskLevel} = 'HIGH' then 1 else 0 end`),
		desc(geoKnowledgeAssertions.updatedAt),
		desc(geoKnowledgeAssertions.id),
	];
	const [rows, [{ total }]] = await Promise.all([
		db
			.select({ assertion: geoKnowledgeAssertions, entity: entityColumns(), openConflicts: openConflictCount })
			.from(geoKnowledgeAssertions)
			.leftJoin(geoSiteEntities, eq(geoSiteEntities.id, geoKnowledgeAssertions.entityId))
			.where(where)
			.orderBy(...order)
			.limit(paging.limit)
			.offset(paging.offset),
		db
			.select({ total: count() })
			.from(geoKnowledgeAssertions)
			.leftJoin(geoSiteEntities, eq(geoSiteEntities.id, geoKnowledgeAssertions.entityId))
			.where(where),
	]);
	return { rows: await hydrateClaims(principal, rows), total };
}

/** The reviewer's queue: everything waiting on a decision, high risk first. */
export function pendingClaimFilters(filters: ClaimFilters): ClaimFilters {
	return { ...filters, status: filters.status?.length ? filters.status : [...PENDING_STATUSES] };
}

export async function knowledgeOverview(principal: GeoPrincipal) {
	assertGeoPermission(principal, "knowledge.read");
	const visible = visibleClaims(principal);
	const showConfidential = canReadConfidential(principal);
	const candidate = aliasedTable(geoKnowledgeAssertions, "candidate");
	const approved = aliasedTable(geoKnowledgeAssertions, "approved");
	const [statuses, [conflicts], [assets]] = await Promise.all([
		db
			.select({ status: geoKnowledgeAssertions.status, total: count() })
			.from(geoKnowledgeAssertions)
			.where(visible)
			.groupBy(geoKnowledgeAssertions.status),
		db
			.select({ total: count() })
			.from(geoAssertionConflicts)
			.innerJoin(candidate, eq(candidate.id, geoAssertionConflicts.candidateId))
			.innerJoin(approved, eq(approved.id, geoAssertionConflicts.approvedId))
			.where(
				and(
					eq(geoAssertionConflicts.organizationId, principal.organizationId),
					eq(geoAssertionConflicts.status, "OPEN"),
					...(showConfidential
						? []
						: [ne(candidate.publicationScope, "CONFIDENTIAL"), ne(approved.publicationScope, "CONFIDENTIAL")]),
				),
			),
		db
			.select({ total: count() })
			.from(geoKnowledgeAssets)
			.where(
				and(
					eq(geoKnowledgeAssets.organizationId, principal.organizationId),
					eq(geoKnowledgeAssets.approvalStatus, "PENDING"),
					...(showConfidential ? [] : [ne(geoKnowledgeAssets.confidentiality, "CONFIDENTIAL")]),
				),
			),
	]);
	const byStatus = Object.fromEntries(statuses.map((row) => [row.status, row.total])) as Partial<
		Record<GeoAssertionStatus, number>
	>;
	return { byStatus, openConflicts: conflicts.total, pendingAssets: assets.total };
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

interface ReviewSourceRef {
	kind: string;
	sourceId: string | null;
	pageVersionId: string | null;
	url: string | null;
	assetId: string | null;
	locator: LocatorFields;
	hidden: boolean;
}

function reviewedAssetIds(reviews: readonly { sourceRef: unknown }[]): string[] {
	return reviews.flatMap((review) =>
		Array.isArray(review.sourceRef)
			? review.sourceRef.flatMap((entry) => {
					const assetId = locatorFields(entry).assetId;
					return typeof assetId === "string" ? [assetId] : [];
				})
			: [],
	);
}

/** Which of these documents the reader may be told about, by their classification as it stands now. */
async function readableAssetIds(principal: GeoPrincipal, assetIds: readonly string[]): Promise<ReadonlySet<string>> {
	if (assetIds.length === 0) return new Set();
	const rows = await db
		.select({ id: geoKnowledgeAssets.id, confidentiality: geoKnowledgeAssets.confidentiality })
		.from(geoKnowledgeAssets)
		.where(
			and(
				eq(geoKnowledgeAssets.organizationId, principal.organizationId),
				inArray(geoKnowledgeAssets.id, [...new Set(assetIds)]),
			),
		);
	return new Set(rows.filter((row) => !hiddenFromReader(principal, row.confidentiality)).map((row) => row.id));
}

function reviewSources(value: unknown, readableAssets: ReadonlySet<string>): ReviewSourceRef[] {
	if (!Array.isArray(value)) return [];
	return value.map((entry) => {
		const fields = locatorFields(entry);
		const text = (key: string) => (typeof fields[key] === "string" ? (fields[key] as string) : null);
		const assetId = text("assetId");
		const hidden = assetId !== null && !readableAssets.has(assetId);
		return {
			kind: text("kind") ?? "UNKNOWN",
			sourceId: hidden ? null : text("sourceId"),
			pageVersionId: text("pageVersionId"),
			url: text("url"),
			assetId: hidden ? null : assetId,
			locator: hidden ? {} : locatorFields((entry as Record<string, unknown> | null)?.locator),
			hidden,
		};
	});
}

async function loadClaim(tx: DbConnection, principal: GeoPrincipal, id: string, lock = false): Promise<AssertionRow> {
	const query = tx
		.select()
		.from(geoKnowledgeAssertions)
		.where(and(visibleClaims(principal), eq(geoKnowledgeAssertions.id, id)))
		.limit(1);
	const [row] = lock ? await query.for("update") : await query;
	if (!row) throw new GeoError("NOT_FOUND", "断言不存在");
	return row;
}

export async function getClaimDetail(principal: GeoPrincipal, id: string) {
	assertGeoPermission(principal, "knowledge.read");
	const assertion = await loadClaim(db, principal, id);
	const showConfidential = canReadConfidential(principal);
	const candidateSide = aliasedTable(geoKnowledgeAssertions, "candidate_side");
	const approvedSide = aliasedTable(geoKnowledgeAssertions, "approved_side");

	const [entity, reviews, conflicts, siblings, tasks, states] = await Promise.all([
		assertion.entityId
			? db
					.select({
						id: geoSiteEntities.id,
						kind: geoSiteEntities.kind,
						title: geoSiteEntities.title,
						canonicalKey: geoSiteEntities.canonicalKey,
						status: geoSiteEntities.status,
					})
					.from(geoSiteEntities)
					.where(eq(geoSiteEntities.id, assertion.entityId))
					.limit(1)
					.then((rows) => rows[0] ?? null)
			: Promise.resolve(null),
		db
			.select()
			.from(geoAssertionReviews)
			.where(
				and(eq(geoAssertionReviews.organizationId, principal.organizationId), eq(geoAssertionReviews.assertionId, id)),
			)
			.orderBy(desc(geoAssertionReviews.reviewedAt)),
		db
			.select({
				conflict: geoAssertionConflicts,
				candidate: {
					id: candidateSide.id,
					claimText: candidateSide.claimText,
					value: candidateSide.normalizedValue,
					status: candidateSide.status,
					scope: candidateSide.publicationScope,
				},
				approved: {
					id: approvedSide.id,
					claimText: approvedSide.claimText,
					value: approvedSide.normalizedValue,
					status: approvedSide.status,
					scope: approvedSide.publicationScope,
				},
			})
			.from(geoAssertionConflicts)
			.innerJoin(candidateSide, eq(candidateSide.id, geoAssertionConflicts.candidateId))
			.innerJoin(approvedSide, eq(approvedSide.id, geoAssertionConflicts.approvedId))
			.where(
				and(
					eq(geoAssertionConflicts.organizationId, principal.organizationId),
					or(eq(geoAssertionConflicts.candidateId, id), eq(geoAssertionConflicts.approvedId, id)),
				),
			)
			.orderBy(desc(geoAssertionConflicts.createdAt)),
		assertion.entityId && assertion.fieldPath
			? db
					.select()
					.from(geoKnowledgeAssertions)
					.where(
						and(
							visibleClaims(principal),
							eq(geoKnowledgeAssertions.entityId, assertion.entityId),
							eq(geoKnowledgeAssertions.fieldPath, assertion.fieldPath),
							eq(geoKnowledgeAssertions.claimType, assertion.claimType),
							ne(geoKnowledgeAssertions.id, id),
						),
					)
					.orderBy(desc(geoKnowledgeAssertions.updatedAt))
					.limit(20)
			: Promise.resolve([] as AssertionRow[]),
		db
			.selectDistinct({
				id: geoOptimizationTasks.id,
				title: geoOptimizationTasks.title,
				state: geoOptimizationTasks.state,
			})
			.from(geoTaskEvidence)
			.innerJoin(geoOptimizationTasks, eq(geoOptimizationTasks.id, geoTaskEvidence.taskId))
			.where(and(eq(geoTaskEvidence.organizationId, principal.organizationId), eq(geoTaskEvidence.assertionId, id))),
		loadFactStates(db, principal.organizationId, [id]),
	]);

	const relatedIds = [
		id,
		...siblings.map((row) => row.id),
		...conflicts.flatMap((row) => [row.candidate.id, row.approved.id]),
	];
	const [sources, readableAssets] = await Promise.all([
		loadAssertionSources(db, principal.organizationId, [...new Set(relatedIds)]),
		readableAssetIds(principal, reviewedAssetIds(reviews)),
	]);
	const own = sources.get(id) ?? [];
	const names = await displayNames([
		...reviews.map((review) => review.reviewerId),
		...conflicts.map((row) => row.conflict.resolvedBy),
		assertion.authorId,
		assertion.frozenBy,
	]);
	const state = states.get(id);
	const now = new Date();
	const risk = effectiveRiskLevel(assertion);
	const visibleSide = (side: {
		id: string;
		claimText: string;
		value: unknown;
		status: GeoAssertionStatus;
		scope: GeoPublicationScope;
	}) =>
		hiddenFromReader(principal, side.scope)
			? { id: side.id, claimText: null, value: null, status: side.status, citations: [] }
			: {
					id: side.id,
					claimText: side.claimText,
					value: knowledgeValue(side.value),
					status: side.status,
					citations: (sources.get(side.id) ?? []).map((source) => citationView(source, showConfidential)),
				};

	return {
		claim: {
			...claimView(assertion, entity ? { id: entity.id, kind: entity.kind, title: entity.title } : null, own, {
				openConflicts: state?.openConflicts ?? 0,
				showConfidential,
			}),
			authorName: nameOf(names, assertion.authorId),
			frozenByName: nameOf(names, assertion.frozenBy),
		},
		entity,
		gates: {
			effectiveRisk: risk,
			hasOriginalDocument: hasValidOriginalDocument(own, now),
			widestScope: widestPublicationScope(own, now),
			validUntilOnApproval: iso(
				effectiveValidUntil({ explicit: assertion.validUntil, riskLevel: risk, sources: own, now }),
			),
		},
		reviews: reviews.map((review) => ({
			id: review.id,
			decision: review.decision,
			reviewerId: review.reviewerId,
			reviewerName: nameOf(names, review.reviewerId),
			basis: review.basis,
			publicationScope: review.publicationScope,
			sourceRef: reviewSources(review.sourceRef, readableAssets),
			reviewedAt: iso(review.reviewedAt) as string,
		})),
		conflicts: conflicts.map((row) => ({
			id: row.conflict.id,
			status: row.conflict.status,
			// A resolution carries the reviewer's basis, which can quote a side this reader may not see.
			resolution:
				hiddenFromReader(principal, row.candidate.scope) || hiddenFromReader(principal, row.approved.scope)
					? (row.conflict.resolution?.split(":")[0] ?? null)
					: row.conflict.resolution,
			resolvedByName: nameOf(names, row.conflict.resolvedBy),
			resolvedAt: iso(row.conflict.resolvedAt),
			createdAt: iso(row.conflict.createdAt) as string,
			candidate: visibleSide(row.candidate),
			approved: visibleSide(row.approved),
		})),
		siblings: siblings.map((row) => ({
			id: row.id,
			claimText: row.claimText,
			normalizedValue: knowledgeValue(row.normalizedValue),
			status: row.status,
			sameValue: canonicalClaimValue(row) === canonicalClaimValue(assertion),
			updatedAt: iso(row.updatedAt) as string,
			citations: (sources.get(row.id) ?? []).map((source) => citationView(source, showConfidential)),
		})),
		tasks,
	};
}
export type KnowledgeClaimDetail = Awaited<ReturnType<typeof getClaimDetail>>;

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

/** The review keeps where its evidence sat. A document's words stay with the document, under its own access rules. */
function sourceRefOf(sources: GeoAssertionSourceRow[]) {
	return sources.map((source) => {
		const { quote: _quote, ...withoutQuote } = locatorFields(source.locator);
		return {
			kind: source.kind,
			sourceId: source.id,
			pageVersionId: source.pageVersionId,
			url: source.url,
			assetId: source.assetId,
			locator: source.kind === "ASSET" ? withoutQuote : source.locator,
			parserVersion: source.parserVersion,
		};
	});
}

async function recordReview(
	tx: DbConnection,
	principal: GeoPrincipal,
	input: {
		assertionId: string;
		decision: "APPROVE" | "REJECT" | "REQUEST_EVIDENCE" | "INVALIDATE" | "FREEZE" | "UNFREEZE";
		basis: string;
		publicationScope?: GeoPublicationScope | null;
		sources: GeoAssertionSourceRow[];
	},
) {
	await tx.insert(geoAssertionReviews).values({
		organizationId: principal.organizationId,
		assertionId: input.assertionId,
		decision: input.decision,
		reviewerId: principal.actorId,
		basis: input.basis,
		publicationScope: input.publicationScope ?? null,
		sourceRef: sourceRefOf(input.sources),
	});
}

async function supersedeOlderValues(tx: DbConnection, principal: GeoPrincipal, approved: AssertionRow) {
	if (!approved.entityId || !approved.fieldPath) return;
	const others = await tx
		.select()
		.from(geoKnowledgeAssertions)
		.where(
			and(
				eq(geoKnowledgeAssertions.organizationId, principal.organizationId),
				eq(geoKnowledgeAssertions.entityId, approved.entityId),
				eq(geoKnowledgeAssertions.fieldPath, approved.fieldPath),
				eq(geoKnowledgeAssertions.claimType, approved.claimType),
				ne(geoKnowledgeAssertions.id, approved.id),
				inArray(geoKnowledgeAssertions.status, ["APPROVED", "SOURCE_UNAVAILABLE"]),
			),
		)
		.for("update");
	const value = canonicalClaimValue(approved);
	for (const other of others) {
		if (other.status === "APPROVED" && canonicalClaimValue(other) === value) continue;
		const to = assertGeoTransition(
			assertionTransition({
				assertion: { status: other.status, riskLevel: other.riskLevel, authorId: other.authorId },
				action: "SUPERSEDE",
				actor: transitionActorOf(principal),
				payload: { supersededById: approved.id },
			}),
		);
		await tx
			.update(geoKnowledgeAssertions)
			.set({ status: to, supersededBy: approved.id })
			.where(eq(geoKnowledgeAssertions.id, other.id));
		await writeGeoAudit(tx, {
			principal,
			action: "knowledge.assertion.supersede",
			entityType: "knowledge_assertion",
			entityId: other.id,
			before: { status: other.status },
			after: { status: to, supersededBy: approved.id },
		});
		await closeAssertionConflicts(tx, principal, { assertionId: other.id, resolution: "SUPERSEDED" });
	}
}

async function applyFreeze(
	tx: DbConnection,
	principal: GeoPrincipal,
	current: AssertionRow,
	input: ClaimReviewInput,
	sources: GeoAssertionSourceRow[],
) {
	assertGeoPermission(principal, "knowledge.review");
	const freezing = input.decision === "FREEZE";
	if (freezing === (current.frozenAt !== null)) {
		throw new GeoError("CONFLICT", freezing ? "该事实已被冻结" : "该事实未被冻结");
	}
	const [after] = await tx
		.update(geoKnowledgeAssertions)
		.set(
			freezing
				? { frozenAt: new Date(), frozenBy: principal.actorId, frozenReason: input.basis }
				: { frozenAt: null, frozenBy: null, frozenReason: null },
		)
		.where(eq(geoKnowledgeAssertions.id, current.id))
		.returning();
	await recordReview(tx, principal, {
		assertionId: current.id,
		decision: freezing ? "FREEZE" : "UNFREEZE",
		basis: input.basis,
		sources,
	});
	await writeGeoAudit(tx, {
		principal,
		action: `knowledge.assertion.${freezing ? "freeze" : "unfreeze"}`,
		entityType: "knowledge_assertion",
		entityId: current.id,
		before: { frozen: current.frozenAt !== null },
		after: { frozen: freezing },
		metadata: { basis: input.basis },
	});
	return after;
}

/** Conflicts are detected afresh, then the gates `assertionTransition` cannot see are checked. */
async function approvalContext(
	tx: DbConnection,
	principal: GeoPrincipal,
	current: AssertionRow,
	input: ClaimReviewInput,
	sources: GeoAssertionSourceRow[],
	now: Date,
) {
	await detectAssertionConflicts(tx, principal, { assertionIds: [current.id] });
	const states = await loadFactStates(tx, principal.organizationId, [current.id]);
	const publicationScope = input.publicationScope ?? null;
	if (publicationScope) {
		const problem = knowledgeApprovalProblem({
			assertion: { riskLevel: current.riskLevel, claimType: current.claimType, frozen: current.frozenAt !== null },
			actorRoles: principal.roles,
			publicationScope,
			sources,
			now,
		});
		if (problem) throw new GeoError(problem.code, problem.message);
	}
	return { hasOpenConflict: (states.get(current.id)?.openConflicts ?? 0) > 0, publicationScope };
}

async function afterReview(tx: DbConnection, principal: GeoPrincipal, action: GeoAssertionAction, after: AssertionRow) {
	if (action === "APPROVE") {
		await supersedeOlderValues(tx, principal, after);
		await detectAssertionConflicts(tx, principal, { assertionIds: [after.id] });
	} else if (action === "REJECT") {
		await closeAssertionConflicts(tx, principal, { assertionId: after.id, resolution: "KEEP_APPROVED" });
	} else if (action === "INVALIDATE") {
		await closeAssertionConflicts(tx, principal, { assertionId: after.id, resolution: "SUPERSEDED" });
	} else if (action === "RESUBMIT") {
		await detectAssertionConflicts(tx, principal, { assertionIds: [after.id] });
	}
}

/**
 * One review decision on one claim, inside the caller's transaction. Approval
 * re-runs conflict detection first, then checks everything PRD 3.8 and 3.12 ask
 * for; an approved value replaces older values of the same field only here,
 * by a named reviewer, never during a crawl.
 */
async function applyClaimReview(tx: DbConnection, principal: GeoPrincipal, id: string, input: ClaimReviewInput) {
	const { entityId, fieldPath, claimType } = await loadClaim(tx, principal, id);
	// Taken before the row lock so two approvals of one field run one after the other,
	// and the second sees the first as a conflict instead of a second approved value.
	if (entityId && fieldPath) await lockClaimField(tx, { entityId, fieldPath, claimType });
	const current = await loadClaim(tx, principal, id, true);
	const sources = (await loadAssertionSources(tx, principal.organizationId, [id])).get(id) ?? [];
	if (input.decision === "FREEZE" || input.decision === "UNFREEZE") {
		return applyFreeze(tx, principal, current, input, sources);
	}

	const action: GeoAssertionAction = input.decision;
	const risk = effectiveRiskLevel(current);
	const now = new Date();
	const approving = action === "APPROVE";
	const context = approving
		? await approvalContext(tx, principal, current, input, sources, now)
		: { hasOpenConflict: false, publicationScope: null };
	const explicit = input.validUntil !== undefined ? parseValidUntil(input.validUntil) : current.validUntil;
	const validUntil = approving ? effectiveValidUntil({ explicit, riskLevel: risk, sources, now }) : current.validUntil;
	const to = assertGeoTransition(
		assertionTransition({
			assertion: { status: current.status, riskLevel: risk, authorId: current.authorId, validUntil },
			action,
			actor: transitionActorOf(principal),
			payload: {
				basis: input.basis,
				publicationScope: context.publicationScope,
				sourceRef: sources.length > 0 ? sourceRefOf(sources) : null,
				hasOriginalDocument: hasValidOriginalDocument(sources, now),
				hasOpenConflict: context.hasOpenConflict,
			},
			now,
		}),
	);

	const patch: Partial<AssertionRow> = approving
		? {
				status: to,
				publicationScope: context.publicationScope ?? current.publicationScope,
				validUntil,
				riskLevel: risk,
			}
		: { status: to };
	const [after] = await tx
		.update(geoKnowledgeAssertions)
		.set(patch)
		.where(eq(geoKnowledgeAssertions.id, id))
		.returning();
	if (action !== "RESUBMIT") {
		await recordReview(tx, principal, {
			assertionId: id,
			decision: action as "APPROVE" | "REJECT" | "REQUEST_EVIDENCE" | "INVALIDATE",
			basis: input.basis,
			publicationScope: context.publicationScope,
			sources,
		});
	}
	await writeGeoAudit(tx, {
		principal,
		action: `knowledge.assertion.${action.toLowerCase()}`,
		entityType: "knowledge_assertion",
		entityId: id,
		before: { status: current.status, publicationScope: current.publicationScope, validUntil: current.validUntil },
		after: { status: to, publicationScope: after.publicationScope, validUntil: after.validUntil },
		metadata: { basis: input.basis },
	});
	await afterReview(tx, principal, action, after);
	return after;
}

/**
 * Reviewers hold `knowledge.review`, writers `knowledge.write`; the state
 * machine and the gates decide which decision this person may take.
 */
export async function reviewClaim(principal: GeoPrincipal, id: string, input: ClaimReviewInput) {
	if (input.decision === "APPROVE" && !input.publicationScope) {
		throw new GeoError("VALIDATION_ERROR", "审核通过必须指定可公开范围");
	}
	const after = await db.transaction((tx) => applyClaimReview(tx, principal, id, input));
	return { id: after.id, status: after.status, frozen: after.frozenAt !== null };
}

// ---------------------------------------------------------------------------
// Conflicts
// ---------------------------------------------------------------------------

export async function listConflicts(
	principal: GeoPrincipal,
	filters: z.infer<typeof conflictFiltersSchema>,
	paging: Paging,
) {
	assertGeoPermission(principal, "knowledge.read");
	const candidate = aliasedTable(geoKnowledgeAssertions, "candidate");
	const approved = aliasedTable(geoKnowledgeAssertions, "approved");
	const showConfidential = canReadConfidential(principal);
	const conditions: SQL[] = [eq(geoAssertionConflicts.organizationId, principal.organizationId)];
	conditions.push(eq(geoAssertionConflicts.status, filters.status ?? "OPEN"));
	if (!showConfidential) {
		conditions.push(ne(candidate.publicationScope, "CONFIDENTIAL"), ne(approved.publicationScope, "CONFIDENTIAL"));
	}
	const where = and(...conditions);
	const base = db
		.select({
			conflict: geoAssertionConflicts,
			candidate,
			approved,
			entity: entityColumns(),
		})
		.from(geoAssertionConflicts)
		.innerJoin(candidate, eq(candidate.id, geoAssertionConflicts.candidateId))
		.innerJoin(approved, eq(approved.id, geoAssertionConflicts.approvedId))
		.leftJoin(geoSiteEntities, eq(geoSiteEntities.id, candidate.entityId));
	const [rows, [{ total }]] = await Promise.all([
		base
			.where(where)
			.orderBy(desc(geoAssertionConflicts.createdAt), desc(geoAssertionConflicts.id))
			.limit(paging.limit)
			.offset(paging.offset),
		db
			.select({ total: count() })
			.from(geoAssertionConflicts)
			.innerJoin(candidate, eq(candidate.id, geoAssertionConflicts.candidateId))
			.innerJoin(approved, eq(approved.id, geoAssertionConflicts.approvedId))
			.where(where),
	]);
	const sources = await loadAssertionSources(
		db,
		principal.organizationId,
		rows.flatMap((row) => [row.candidate.id, row.approved.id]),
	);
	const side = (row: AssertionRow) => ({
		id: row.id,
		claimText: row.claimText,
		normalizedValue: knowledgeValue(row.normalizedValue),
		status: row.status,
		riskLevel: effectiveRiskLevel(row),
		citations: (sources.get(row.id) ?? []).map((source) => citationView(source, showConfidential)),
	});
	return {
		rows: rows.map((row) => ({
			id: row.conflict.id,
			status: row.conflict.status,
			resolution: row.conflict.resolution,
			createdAt: iso(row.conflict.createdAt) as string,
			resolvedAt: iso(row.conflict.resolvedAt),
			entity: row.entity,
			fieldPath: row.candidate.fieldPath,
			claimType: row.candidate.claimType,
			candidate: side(row.candidate),
			approved: side(row.approved),
		})),
		total,
	};
}
export type KnowledgeConflictRow = Awaited<ReturnType<typeof listConflicts>>["rows"][number];

/**
 * Keep the approved value (the new one is rejected) or accept the new one
 * (approved with every usual gate, the old one superseded). Either way a named
 * reviewer decides; nothing is overwritten automatically.
 */
export async function resolveConflict(principal: GeoPrincipal, conflictId: string, input: ConflictResolutionInput) {
	assertGeoPermission(principal, "knowledge.review");
	return db.transaction(async (tx) => {
		const scoped = and(
			eq(geoAssertionConflicts.organizationId, principal.organizationId),
			eq(geoAssertionConflicts.id, conflictId),
		);
		// The field lock comes before the conflict row, in the order a review of the candidate takes them.
		const [field] = await tx
			.select({
				entityId: geoKnowledgeAssertions.entityId,
				fieldPath: geoKnowledgeAssertions.fieldPath,
				claimType: geoKnowledgeAssertions.claimType,
			})
			.from(geoAssertionConflicts)
			.innerJoin(geoKnowledgeAssertions, eq(geoKnowledgeAssertions.id, geoAssertionConflicts.candidateId))
			.where(scoped)
			.limit(1);
		if (field?.entityId && field.fieldPath) {
			await lockClaimField(tx, { entityId: field.entityId, fieldPath: field.fieldPath, claimType: field.claimType });
		}
		const [conflict] = await tx.select().from(geoAssertionConflicts).where(scoped).for("update").limit(1);
		if (!conflict) throw new GeoError("NOT_FOUND", "冲突不存在");
		if (conflict.status !== "OPEN") throw new GeoError("CONFLICT", "该冲突已处理");
		await tx
			.update(geoAssertionConflicts)
			.set({
				status: "RESOLVED",
				resolution: `${input.resolution}: ${input.basis}`,
				resolvedBy: principal.actorId,
				resolvedAt: new Date(),
			})
			.where(eq(geoAssertionConflicts.id, conflict.id));
		await writeGeoAudit(tx, {
			principal,
			action: "knowledge.conflict.resolve",
			entityType: "assertion_conflict",
			entityId: conflict.id,
			metadata: { resolution: input.resolution, basis: input.basis },
		});
		if (input.resolution === "KEEP_APPROVED") {
			await applyClaimReview(tx, principal, conflict.candidateId, { decision: "REJECT", basis: input.basis });
		} else {
			if (!input.publicationScope) throw new GeoError("VALIDATION_ERROR", "采用新值必须指定可公开范围");
			await applyClaimReview(tx, principal, conflict.candidateId, {
				decision: "APPROVE",
				basis: input.basis,
				publicationScope: input.publicationScope,
				validUntil: input.validUntil,
			});
		}
		return { id: conflict.id, resolution: input.resolution };
	});
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

export async function searchEntities(principal: GeoPrincipal, input: z.infer<typeof entitySearchSchema>) {
	assertGeoPermission(principal, "knowledge.read");
	const conditions: SQL[] = [eq(geoSiteEntities.organizationId, principal.organizationId)];
	if (input.kind) conditions.push(eq(geoSiteEntities.kind, input.kind));
	if (input.q) {
		const pattern = `%${input.q.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
		const match = or(ilike(geoSiteEntities.title, pattern), ilike(geoSiteEntities.canonicalKey, pattern));
		if (match) conditions.push(match);
	}
	return db
		.select({
			id: geoSiteEntities.id,
			kind: geoSiteEntities.kind,
			title: geoSiteEntities.title,
			canonicalKey: geoSiteEntities.canonicalKey,
			status: geoSiteEntities.status,
			// Aliased and spelled out: drizzle drops table names from columns in a
			// single-table selection, which would leave every "id" here ambiguous.
			pageCount: sql<number>`(
				select count(distinct v.page_id)::int from ${geoSiteEntitySources} s
				join ${geoSitePageVersions} v on v.id = s.page_version_id
				where s.entity_id = ${sql.identifier(getTableName(geoSiteEntities))}.${sql.identifier(geoSiteEntities.id.name)}
			)`,
		})
		.from(geoSiteEntities)
		.where(and(...conditions))
		.orderBy(asc(geoSiteEntities.kind), asc(geoSiteEntities.title))
		.limit(50);
}

// ---------------------------------------------------------------------------
// Facts a public draft may use
// ---------------------------------------------------------------------------

export const draftFactFiltersSchema = z.object({
	q: z.string().trim().max(200).optional(),
	entityId: z.string().uuid().optional(),
});

/**
 * Approved, PUBLIC, in date, not frozen, not disputed: the only facts that may
 * reach a public draft or a model. Customer documents appear only when they
 * were filed as public; their contents never do.
 */
export async function listDraftFacts(principal: GeoPrincipal, filters: z.infer<typeof draftFactFiltersSchema>) {
	assertGeoPermission(principal, "content.read");
	const conditions: SQL[] = [
		eq(geoKnowledgeAssertions.organizationId, principal.organizationId),
		eq(geoKnowledgeAssertions.status, "APPROVED"),
		eq(geoKnowledgeAssertions.publicationScope, "PUBLIC"),
		isNull(geoKnowledgeAssertions.frozenAt),
		sql`(${geoKnowledgeAssertions.validUntil} is null or ${geoKnowledgeAssertions.validUntil} > now())`,
		sql`${openConflictCount} = 0`,
	];
	if (filters.entityId) conditions.push(eq(geoKnowledgeAssertions.entityId, filters.entityId));
	if (filters.q) {
		const tokens = searchTokensOf(filters.q);
		if (!tokens) return [];
		conditions.push(
			sql`to_tsvector('simple', ${geoKnowledgeAssertions.searchTokens}) @@ plainto_tsquery('simple', ${tokens})`,
		);
	}
	const rows = await db
		.select({ assertion: geoKnowledgeAssertions, entity: entityColumns(), openConflicts: openConflictCount })
		.from(geoKnowledgeAssertions)
		.leftJoin(geoSiteEntities, eq(geoSiteEntities.id, geoKnowledgeAssertions.entityId))
		.where(and(...conditions))
		.orderBy(asc(geoSiteEntities.title), asc(geoKnowledgeAssertions.fieldPath))
		.limit(200);
	return publicFactViews(principal, rows);
}

async function publicFactViews(
	principal: GeoPrincipal,
	rows: { assertion: AssertionRow; entity: { id: string; kind: string; title: string } | null }[],
) {
	const sources = await loadAssertionSources(
		db,
		principal.organizationId,
		rows.map((row) => row.assertion.id),
	);
	return rows.map(({ assertion, entity }) => ({
		id: assertion.id,
		entity,
		claimType: assertion.claimType,
		fieldPath: assertion.fieldPath,
		claimText: assertion.claimText,
		normalizedValue: knowledgeValue(assertion.normalizedValue),
		riskLevel: effectiveRiskLevel(assertion),
		validUntil: iso(assertion.validUntil),
		sources: publicSources(sources.get(assertion.id) ?? []),
	}));
}
export type DraftFactView = Awaited<ReturnType<typeof listDraftFacts>>[number];

export type PublicSource =
	| { kind: "PAGE_VERSION"; url: string; pageVersionId: string | null; fieldPath: string | null }
	| { kind: "ASSET"; assetId: string | null; title: string | null; page: number | null };

function publicSource(source: GeoAssertionSourceRow): PublicSource | null {
	const locator = locatorFields(source.locator);
	if (source.kind === "PAGE_VERSION") {
		if (source.pageStatus === "GONE" || !source.url) return null;
		return {
			kind: "PAGE_VERSION",
			url: source.url,
			pageVersionId: source.pageVersionId,
			fieldPath: textField(locator, "fieldPath"),
		};
	}
	if (source.assetPublicationScope !== "PUBLIC" || source.assetApproval !== "APPROVED") return null;
	return {
		kind: "ASSET",
		assetId: source.assetId,
		title: source.assetTitle,
		page: typeof locator.page === "number" ? locator.page : null,
	};
}

/** Only what may be shown outside: website pages, and documents filed as public (title and page, nothing more). */
export function publicSources(sources: readonly GeoAssertionSourceRow[]): PublicSource[] {
	return sources.map(publicSource).filter((source): source is PublicSource => source !== null);
}

/** Loads facts for a draft by id and refuses any that may not be used. */
export async function loadDraftFacts(principal: GeoPrincipal, assertionIds: readonly string[]) {
	const ids = [...new Set(assertionIds)];
	const rows = await db
		.select({ assertion: geoKnowledgeAssertions, entity: entityColumns() })
		.from(geoKnowledgeAssertions)
		.leftJoin(geoSiteEntities, eq(geoSiteEntities.id, geoKnowledgeAssertions.entityId))
		.where(
			and(eq(geoKnowledgeAssertions.organizationId, principal.organizationId), inArray(geoKnowledgeAssertions.id, ids)),
		);
	const states = await loadFactStates(db, principal.organizationId, ids);
	const refused = ids.filter((id) => factBlockers(states.get(id)).length > 0);
	if (refused.length > 0) {
		throw new GeoError(
			"EVIDENCE_REQUIRED",
			`有 ${refused.length} 条事实未审核通过、不在公开范围、已过期、已冻结或存在冲突，不能用于公开草稿`,
		);
	}
	const byId = new Map(rows.map((row) => [row.assertion.id, row]));
	const ordered = ids.map((id) => byId.get(id)).filter((row): row is (typeof rows)[number] => Boolean(row));
	return publicFactViews(principal, ordered);
}
