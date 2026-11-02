import type { GeoCrawlMode, GeoParseStatus, GeoRiskLevel, GeoSiteEntityKind } from "@workspace/geo-domain";
import type { SiteProfile } from "./profile";

export interface CrawlerInput {
	organizationId: string;
	siteSourceId: string;
	mode: GeoCrawlMode;
	seedUrls: string[];
	maxPages: number;
	policyVersion: string;
	idempotencyKey: string;
}

/** What one fetch produced. The raw page is always kept; parsed text never replaces it. */
export interface PageSnapshot {
	normalizedUrl: string;
	httpStatus: number;
	contentType: string | null;
	fetchedAt: string;
	title: string | null;
	htmlObjectKey: string;
	contentHash: string;
	discoveredLinks: DiscoveredLink[];
	parserVersion: string;
	parseStatus: GeoParseStatus;
	errorCode: string | null;
}

export type DiscoveredLinkKind = "PAGE" | "PAGINATION" | "ASSET";

export interface DiscoveredLink {
	url: string;
	kind: DiscoveredLinkKind;
	nofollow: boolean;
	text: string;
}

export interface PageDiscovery {
	links: DiscoveredLink[];
	canonical: string | null;
	metaNoindex: boolean;
	metaNofollow: boolean;
	title: string | null;
}

/** Finds what to crawl next: links, pagination, attachments, canonical and sitemap entries. */
export interface SiteDiscoveryAdapter {
	discover(html: string, pageUrl: string, profile: SiteProfile): PageDiscovery;
	sitemapUrls(xml: string, sitemapUrl: string): { pages: string[]; sitemaps: string[] };
}

export interface ParsedTable {
	caption: string | null;
	rows: string[][];
}

export interface ParsedImage {
	src: string;
	alt: string | null;
}

export interface FieldLocator {
	/** The selector that matched, so a reviewer can find the value in the snapshot. */
	selector: string;
	ordinal: number;
	quote: string;
}

export interface ParsedField {
	path: string;
	label: string | null;
	type: string;
	value: string | string[] | string[][] | null;
	locator: FieldLocator | null;
	claimType: string | null;
	risk: GeoRiskLevel | null;
}

export interface ParsedPage {
	parserVersion: string;
	url: string;
	category: string | null;
	categoryLabel: string | null;
	entityKind: GeoSiteEntityKind | null;
	role: "detail" | "listing" | "section" | null;
	title: string | null;
	metaDescription: string | null;
	h1: string | null;
	canonical: string | null;
	lang: string | null;
	publishedAt: string | null;
	text: string;
	headings: string[];
	tables: ParsedTable[];
	images: ParsedImage[];
	fields: ParsedField[];
	warnings: string[];
}

export type ParseOutcome =
	| { status: "PARSED"; page: ParsedPage }
	| { status: "FAILED"; page: ParsedPage | null; errorCode: string; message: string };

/** HTML in, structured page out. Pure: the same HTML and profile always give the same result. */
export interface SitePageParser {
	readonly version: string;
	parse(html: string, url: string, profile: SiteProfile): ParseOutcome;
}

export interface EntityFieldValue {
	path: string;
	label: string | null;
	value: string | string[] | string[][];
	locator: FieldLocator | null;
	claimType: string | null;
	risk: GeoRiskLevel | null;
}

export interface EntityCandidate {
	kind: GeoSiteEntityKind;
	/** Stable across pages and crawls, so several pages about one product meet in one entity. */
	canonicalKey: string;
	title: string;
	attributes: Record<string, unknown>;
	fields: EntityFieldValue[];
}

/** Turns a parsed page into entity candidates with cleaned, comparable values. */
export interface ContentNormalizer {
	normalize(page: ParsedPage): EntityCandidate[];
}

export interface AssertionCandidate {
	claimType: string;
	fieldPath: string;
	claimText: string;
	normalizedValue: unknown;
	riskLevel: GeoRiskLevel;
	locator: FieldLocator | null;
}

/** Decides which entity fields become reviewable claims and how risky each one is. */
export interface KnowledgeMapper {
	map(entity: EntityCandidate, profile: SiteProfile): AssertionCandidate[];
}
