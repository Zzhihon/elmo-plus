import type { GeoCrawlItemOutcome } from "@workspace/geo-domain";
import type { SafeFetchFailure } from "./net/safe-fetch";

export const CRAWLER_PRODUCT_TOKEN = "ElmoGeoSiteIngestion";
export const CRAWLER_VERSION = "1.0";

export const LIMITS = {
	htmlBytes: 5 * 1024 * 1024,
	robotsBytes: 512 * 1024,
	sitemapBytes: 10 * 1024 * 1024,
	defaultAssetBytes: 20 * 1024 * 1024,
	fetchTimeoutMs: 20_000,
	assetTimeoutMs: 60_000,
	maxRedirects: 5,
	maxAttempts: 3,
	backoffBaseMs: 2_000,
	backoffMaxMs: 60_000,
	retryAfterMaxMs: 120_000,
	breakerThreshold: 5,
	breakerCooldownMs: 30 * 60_000,
	defaultMaxPages: 500,
	hardMaxPages: 20_000,
	sitemapMaxUrls: 50_000,
	sitemapMaxFiles: 10,
	chunkMs: 4 * 60_000,
} as const;

export const HTML_MIME_TYPES = ["text/html", "application/xhtml+xml"] as const;
export const SITEMAP_MIME_TYPES = ["application/xml", "text/xml", "application/x-xml", "text/plain"] as const;
export const ROBOTS_MIME_TYPES = ["text/plain"] as const;

export function userAgentOf(contact: string | null | undefined): string {
	const trimmed = contact?.trim();
	return trimmed
		? `${CRAWLER_PRODUCT_TOKEN}/${CRAWLER_VERSION} (+${trimmed})`
		: `${CRAWLER_PRODUCT_TOKEN}/${CRAWLER_VERSION}`;
}

export type ResponseClass =
	| { kind: "OK" }
	| { kind: "GONE" }
	| { kind: "AUTH_REQUIRED" }
	| { kind: "CLIENT_ERROR" }
	| { kind: "RETRYABLE"; outcome: GeoCrawlItemOutcome };

/** 4xx splits into "the page is gone" and "the page wants credentials", which must not be confused. */
export function classifyStatus(status: number): ResponseClass {
	if (status >= 200 && status < 300) return { kind: "OK" };
	if (status === 404 || status === 410) return { kind: "GONE" };
	if (status === 401 || status === 403 || status === 407) return { kind: "AUTH_REQUIRED" };
	if (status === 408 || status === 425 || status === 429) return { kind: "RETRYABLE", outcome: "CLIENT_ERROR" };
	if (status >= 500) return { kind: "RETRYABLE", outcome: "SERVER_ERROR" };
	return { kind: "CLIENT_ERROR" };
}

export function isRetryableFailure(code: SafeFetchFailure): boolean {
	return code === "TIMEOUT" || code === "NETWORK" || code === "DNS_FAILED";
}

export function outcomeOfFailure(code: SafeFetchFailure): GeoCrawlItemOutcome {
	switch (code) {
		case "REDIRECT_BLOCKED":
		case "TOO_MANY_REDIRECTS":
			return "REDIRECT_BLOCKED";
		case "REDIRECT_REFUSED":
			return "ROBOTS_DISALLOWED";
		case "ADDRESS_BLOCKED":
			return "ADDRESS_BLOCKED";
		case "MIME_REJECTED":
			return "MIME_REJECTED";
		case "TOO_LARGE":
			return "TOO_LARGE";
		case "URL_REFUSED":
			return "OUT_OF_SCOPE";
		default:
			return "NETWORK_ERROR";
	}
}

/** Doubling from two seconds, capped; a server's Retry-After wins when it asks for longer, up to a bound. */
export function backoffMs(attempt: number, retryAfterHeader?: string | null, now = Date.now()): number {
	const exponential = Math.min(LIMITS.backoffBaseMs * 2 ** Math.max(attempt - 1, 0), LIMITS.backoffMaxMs);
	if (!retryAfterHeader) return exponential;
	const seconds = Number(retryAfterHeader);
	const requested = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfterHeader) - now;
	if (!Number.isFinite(requested) || requested <= 0) return exponential;
	return Math.min(Math.max(exponential, requested), LIMITS.retryAfterMaxMs);
}

export type VersionDecision = "NEW_VERSION" | "UNCHANGED" | "DUPLICATE";

/**
 * Whether a fetched page earns a new immutable version. Same content as the
 * page's latest version: unchanged. Same content as a different page of the
 * site: a duplicate URL, recorded but not versioned twice.
 */
export function decideVersion(input: {
	contentHash: string;
	latestHashOfPage: string | null;
	pageWithSameContent: string | null;
	pageId: string;
}): VersionDecision {
	if (input.latestHashOfPage === input.contentHash) return "UNCHANGED";
	if (input.pageWithSameContent && input.pageWithSameContent !== input.pageId) return "DUPLICATE";
	return "NEW_VERSION";
}

/** Configuration can slow the crawl down but never push it past two requests a second. */
export const MAX_REQUESTS_PER_SECOND = 2;

export function minIntervalMs(requestsPerSecond: number, crawlDelaySeconds: number | null): number {
	const rate = Math.min(requestsPerSecond > 0 ? requestsPerSecond : 1, MAX_REQUESTS_PER_SECOND);
	return Math.max(1000 / rate, (crawlDelaySeconds ?? 0) * 1000);
}
