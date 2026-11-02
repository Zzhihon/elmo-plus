import { type GeoCitationAttribution, type GeoDictionarySnapshot, normalizeBrandDomain } from "@workspace/geo-domain";
import { hostOf, normalizeUrl } from "@workspace/geo-evidence";

export interface CitationInput {
	ordinal: number;
	url: string;
	normalizedUrl?: string | null;
	host?: string | null;
}

function siteIdentity(host: string): string {
	return host.toLowerCase().replace(/^www\./, "");
}

/**
 * Which side a cited page belongs to, by its registered domains (and official site) in the
 * dictionary version the evaluation used. A subdomain belongs to its parent domain.
 */
export function attributeCitations(
	citations: readonly CitationInput[],
	dictionary: GeoDictionarySnapshot,
): GeoCitationAttribution[] {
	const owners: { domain: string; entityId: string; owner: "OWN" | "COMPETITOR" }[] = [];
	for (const entity of dictionary.entities) {
		if (entity.status !== "ACTIVE") continue;
		const domains = [...entity.domains, ...(entity.officialUrl ? [entity.officialUrl] : [])]
			.map((value) => normalizeBrandDomain(value))
			.filter((value): value is string => value !== null);
		for (const domain of new Set(domains.map(siteIdentity))) {
			owners.push({ domain, entityId: entity.id, owner: entity.kind === "OWN" ? "OWN" : "COMPETITOR" });
		}
	}
	owners.sort((a, b) => b.domain.length - a.domain.length);

	return citations.map((citation) => {
		const normalizedUrl = citation.normalizedUrl ?? normalizeUrl(citation.url);
		const host = citation.host ?? hostOf(normalizedUrl ?? citation.url);
		const identity = host ? siteIdentity(host) : null;
		const match = identity
			? owners.find(({ domain }) => identity === domain || identity.endsWith(`.${domain}`))
			: undefined;
		return {
			ordinal: citation.ordinal,
			normalizedUrl,
			host,
			owner: match?.owner ?? "THIRD_PARTY",
			entityId: match?.entityId ?? null,
		};
	});
}
