import { useQuery } from "@tanstack/react-query";
import { getGeoDraftChoicesFn, getGeoDraftFn, listGeoDraftsFn } from "@/server/geo/drafts";
import type { DraftFilters } from "@/server/geo/drafts-core";
import {
	getKnowledgeAssetFn,
	getKnowledgeClaimFn,
	getKnowledgeOverviewFn,
	listDraftFactsFn,
	listKnowledgeAssetChoicesFn,
	listKnowledgeAssetsFn,
	listKnowledgeConflictsFn,
	searchKnowledgeClaimsFn,
} from "@/server/geo/knowledge";
import type { AssetFilters } from "@/server/geo/knowledge-assets-core";
import type { ClaimFilters } from "@/server/geo/knowledge-core";

export const knowledgeKeys = {
	all: (organizationId: string) => ["geo-knowledge", organizationId] as const,
	overview: (organizationId: string) => ["geo-knowledge", organizationId, "overview"] as const,
	claims: (organizationId: string, filters: ClaimFilters, pendingOnly: boolean, page: number) =>
		["geo-knowledge", organizationId, "claims", filters, pendingOnly, page] as const,
	claim: (organizationId: string, claimId: string) => ["geo-knowledge", organizationId, "claim", claimId] as const,
	conflicts: (organizationId: string, status: "OPEN" | "RESOLVED", page: number) =>
		["geo-knowledge", organizationId, "conflicts", status, page] as const,
	assets: (organizationId: string, filters: AssetFilters, page: number) =>
		["geo-knowledge", organizationId, "assets", filters, page] as const,
	asset: (organizationId: string, assetId: string) => ["geo-knowledge", organizationId, "asset", assetId] as const,
	assetChoices: (organizationId: string) => ["geo-knowledge", organizationId, "asset-choices"] as const,
	draftFacts: (organizationId: string, q: string) => ["geo-knowledge", organizationId, "draft-facts", q] as const,
	drafts: (organizationId: string, filters: DraftFilters, page: number) =>
		["geo-knowledge", organizationId, "drafts", filters, page] as const,
	draft: (organizationId: string, draftId: string) => ["geo-knowledge", organizationId, "draft", draftId] as const,
	draftChoices: (organizationId: string) => ["geo-knowledge", organizationId, "draft-choices"] as const,
};

export function useKnowledgeOverview(organizationId: string) {
	return useQuery({
		queryKey: knowledgeKeys.overview(organizationId),
		queryFn: () => getKnowledgeOverviewFn({ data: { organizationId } }),
	});
}

export function useKnowledgeClaims(
	organizationId: string,
	filters: ClaimFilters,
	page: number,
	options: { pendingOnly?: boolean; limit?: number } = {},
) {
	const pendingOnly = options.pendingOnly ?? false;
	return useQuery({
		queryKey: knowledgeKeys.claims(organizationId, filters, pendingOnly, page),
		queryFn: () =>
			searchKnowledgeClaimsFn({
				data: { organizationId, filters, pendingOnly, page, limit: options.limit ?? 20 },
			}),
		placeholderData: (previous) => previous,
	});
}

export function useKnowledgeClaim(organizationId: string, claimId: string) {
	return useQuery({
		queryKey: knowledgeKeys.claim(organizationId, claimId),
		queryFn: () => getKnowledgeClaimFn({ data: { organizationId, claimId } }),
	});
}

export function useKnowledgeConflicts(organizationId: string, status: "OPEN" | "RESOLVED", page: number) {
	return useQuery({
		queryKey: knowledgeKeys.conflicts(organizationId, status, page),
		queryFn: () => listKnowledgeConflictsFn({ data: { organizationId, filters: { status }, page, limit: 10 } }),
		placeholderData: (previous) => previous,
	});
}

export function useKnowledgeAssets(organizationId: string, filters: AssetFilters, page: number) {
	return useQuery({
		queryKey: knowledgeKeys.assets(organizationId, filters, page),
		queryFn: () => listKnowledgeAssetsFn({ data: { organizationId, filters, page, limit: 20 } }),
		placeholderData: (previous) => previous,
	});
}

export function useKnowledgeAsset(organizationId: string, assetId: string) {
	return useQuery({
		queryKey: knowledgeKeys.asset(organizationId, assetId),
		queryFn: () => getKnowledgeAssetFn({ data: { organizationId, assetId } }),
	});
}

export function useKnowledgeAssetChoices(organizationId: string, enabled = true) {
	return useQuery({
		queryKey: knowledgeKeys.assetChoices(organizationId),
		queryFn: () => listKnowledgeAssetChoicesFn({ data: { organizationId } }),
		enabled,
	});
}

export function useDraftFacts(organizationId: string, q: string, enabled = true) {
	return useQuery({
		queryKey: knowledgeKeys.draftFacts(organizationId, q),
		queryFn: () => listDraftFactsFn({ data: { organizationId, filters: q ? { q } : {} } }),
		enabled,
		placeholderData: (previous) => previous,
	});
}

export function useGeoDrafts(organizationId: string, filters: DraftFilters, page: number) {
	return useQuery({
		queryKey: knowledgeKeys.drafts(organizationId, filters, page),
		queryFn: () => listGeoDraftsFn({ data: { organizationId, filters, page, limit: 20 } }),
		placeholderData: (previous) => previous,
	});
}

export function useGeoDraft(organizationId: string, draftId: string) {
	return useQuery({
		queryKey: knowledgeKeys.draft(organizationId, draftId),
		queryFn: () => getGeoDraftFn({ data: { organizationId, draftId } }),
	});
}

export function useGeoDraftChoices(organizationId: string, enabled = true) {
	return useQuery({
		queryKey: knowledgeKeys.draftChoices(organizationId),
		queryFn: () => getGeoDraftChoicesFn({ data: { organizationId } }),
		staleTime: 60_000,
		enabled,
	});
}
