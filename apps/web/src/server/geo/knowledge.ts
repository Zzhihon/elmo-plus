import { createServerFn } from "@tanstack/react-start";
import { getDeployment } from "@workspace/deployment";
import { GeoError } from "@workspace/geo-domain";
import { z } from "zod";
import { READ_ONLY_MESSAGE } from "@/lib/read-only-errors";
import { requireGeoServerFnPrincipal, resolveGeoSessionPrincipal } from "./context";
import {
	assetFiltersSchema,
	assetReviewSchema,
	assetUpdateSchema,
	attachAssetSource,
	attachSourceSchema,
	getKnowledgeAsset,
	listAssetChoices,
	listKnowledgeAssets,
	registerAssetClaim,
	registerClaimSchema,
	reviewKnowledgeAsset,
	updateKnowledgeAsset,
} from "./knowledge-assets-core";
import {
	claimFiltersSchema,
	claimReviewSchema,
	conflictFiltersSchema,
	conflictResolutionSchema,
	draftFactFiltersSchema,
	entitySearchSchema,
	getClaimDetail,
	knowledgeOverview,
	listConflicts,
	listDraftFacts,
	pendingClaimFilters,
	resolveConflict,
	reviewClaim,
	searchClaims,
	searchEntities,
} from "./knowledge-core";

const orgOnly = z.object({ organizationId: z.string() });
const paged = {
	page: z.number().int().min(1).default(1),
	limit: z.number().int().min(1).max(100).default(20),
};

function pageOf<T>(result: { rows: T[]; total: number }, page: number, limit: number) {
	return { ...result, page, totalPages: Math.max(1, Math.ceil(result.total / limit)) };
}

async function writablePrincipal(organizationId: string) {
	const principal = await resolveGeoSessionPrincipal(organizationId);
	if (getDeployment().features.readOnly) throw new GeoError("FORBIDDEN", READ_ONLY_MESSAGE);
	return principal;
}

export const getKnowledgeOverviewFn = createServerFn({ method: "GET" })
	.validator(orgOnly)
	.handler(async ({ data }) => {
		const principal = await requireGeoServerFnPrincipal(data.organizationId, "knowledge.read");
		return knowledgeOverview(principal);
	});

export const searchKnowledgeClaimsFn = createServerFn({ method: "GET" })
	.validator(orgOnly.extend({ filters: claimFiltersSchema.optional(), pendingOnly: z.boolean().optional(), ...paged }))
	.handler(async ({ data }) => {
		const principal = await requireGeoServerFnPrincipal(data.organizationId, "knowledge.read");
		const filters = data.pendingOnly ? pendingClaimFilters(data.filters ?? {}) : (data.filters ?? {});
		const result = await searchClaims(principal, filters, { limit: data.limit, offset: (data.page - 1) * data.limit });
		return pageOf(result, data.page, data.limit);
	});

export const getKnowledgeClaimFn = createServerFn({ method: "GET" })
	.validator(orgOnly.extend({ claimId: z.string().uuid() }))
	.handler(async ({ data }) => {
		const principal = await requireGeoServerFnPrincipal(data.organizationId, "knowledge.read");
		return getClaimDetail(principal, data.claimId);
	});

export const reviewKnowledgeClaimFn = createServerFn({ method: "POST" })
	.validator(orgOnly.extend({ claimId: z.string().uuid(), input: claimReviewSchema }))
	.handler(async ({ data }) => reviewClaim(await writablePrincipal(data.organizationId), data.claimId, data.input));

export const attachKnowledgeSourceFn = createServerFn({ method: "POST" })
	.validator(orgOnly.extend({ claimId: z.string().uuid(), input: attachSourceSchema }))
	.handler(async ({ data }) => {
		const principal = await requireGeoServerFnPrincipal(data.organizationId, "knowledge.write");
		return attachAssetSource(principal, data.claimId, data.input);
	});

export const listKnowledgeConflictsFn = createServerFn({ method: "GET" })
	.validator(orgOnly.extend({ filters: conflictFiltersSchema.optional(), ...paged }))
	.handler(async ({ data }) => {
		const principal = await requireGeoServerFnPrincipal(data.organizationId, "knowledge.read");
		const result = await listConflicts(principal, data.filters ?? {}, {
			limit: data.limit,
			offset: (data.page - 1) * data.limit,
		});
		return pageOf(result, data.page, data.limit);
	});

export const resolveKnowledgeConflictFn = createServerFn({ method: "POST" })
	.validator(orgOnly.extend({ conflictId: z.string().uuid(), input: conflictResolutionSchema }))
	.handler(async ({ data }) => {
		const principal = await requireGeoServerFnPrincipal(data.organizationId, "knowledge.review");
		return resolveConflict(principal, data.conflictId, data.input);
	});

export const searchKnowledgeEntitiesFn = createServerFn({ method: "GET" })
	.validator(orgOnly.extend({ input: entitySearchSchema }))
	.handler(async ({ data }) => {
		const principal = await requireGeoServerFnPrincipal(data.organizationId, "knowledge.read");
		return searchEntities(principal, data.input);
	});

export const listKnowledgeAssetsFn = createServerFn({ method: "GET" })
	.validator(orgOnly.extend({ filters: assetFiltersSchema.optional(), ...paged }))
	.handler(async ({ data }) => {
		const principal = await requireGeoServerFnPrincipal(data.organizationId, "knowledge.read");
		const result = await listKnowledgeAssets(principal, data.filters ?? {}, {
			limit: data.limit,
			offset: (data.page - 1) * data.limit,
		});
		return pageOf(result, data.page, data.limit);
	});

export const getKnowledgeAssetFn = createServerFn({ method: "GET" })
	.validator(orgOnly.extend({ assetId: z.string().uuid() }))
	.handler(async ({ data }) => {
		const principal = await requireGeoServerFnPrincipal(data.organizationId, "knowledge.read");
		return getKnowledgeAsset(principal, data.assetId);
	});

export const listKnowledgeAssetChoicesFn = createServerFn({ method: "GET" })
	.validator(orgOnly)
	.handler(async ({ data }) => {
		const principal = await requireGeoServerFnPrincipal(data.organizationId, "knowledge.read");
		return listAssetChoices(principal);
	});

export const updateKnowledgeAssetFn = createServerFn({ method: "POST" })
	.validator(orgOnly.extend({ assetId: z.string().uuid(), input: assetUpdateSchema }))
	.handler(async ({ data }) => {
		const principal = await requireGeoServerFnPrincipal(data.organizationId, "knowledge.write");
		const asset = await updateKnowledgeAsset(principal, data.assetId, data.input);
		return { id: asset.id };
	});

export const reviewKnowledgeAssetFn = createServerFn({ method: "POST" })
	.validator(orgOnly.extend({ assetId: z.string().uuid(), input: assetReviewSchema }))
	.handler(async ({ data }) => {
		const principal = await requireGeoServerFnPrincipal(data.organizationId, "knowledge.review");
		const asset = await reviewKnowledgeAsset(principal, data.assetId, data.input);
		return { id: asset.id, approvalStatus: asset.approvalStatus };
	});

export const registerAssetClaimFn = createServerFn({ method: "POST" })
	.validator(orgOnly.extend({ assetId: z.string().uuid(), input: registerClaimSchema }))
	.handler(async ({ data }) => {
		const principal = await requireGeoServerFnPrincipal(data.organizationId, "knowledge.write");
		return registerAssetClaim(principal, data.assetId, data.input);
	});

export const listDraftFactsFn = createServerFn({ method: "GET" })
	.validator(orgOnly.extend({ filters: draftFactFiltersSchema.optional() }))
	.handler(async ({ data }) => {
		const principal = await requireGeoServerFnPrincipal(data.organizationId, "content.read");
		return listDraftFacts(principal, data.filters ?? {});
	});
