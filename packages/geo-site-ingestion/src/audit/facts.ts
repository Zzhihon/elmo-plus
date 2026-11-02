import type { GeoSiteEntityKind } from "@workspace/geo-domain";
import { normalizeUrl } from "@workspace/geo-evidence";
import * as cheerio from "cheerio";
import type { ParsedPage } from "../contracts";
import { isAllowedHost } from "../net/url-policy";

/** Everything the page rules look at, read once from a stored version's HTML and its parse. */
export interface AuditPageFacts {
	pageId: string;
	versionId: string | null;
	url: string;
	isHome: boolean;
	/** The page is in a section the customer marked as key, which raises its findings' priority. */
	keySection: boolean;
	category: string | null;
	categoryLabel: string | null;
	role: ParsedPage["role"];
	entityKind: GeoSiteEntityKind | null;
	htmlTitle: string | null;
	metaDescription: string | null;
	h1s: string[];
	/** Every canonical link, resolved; one that cannot be resolved is kept raw in `invalidCanonicals`. */
	canonicals: string[];
	invalidCanonicals: string[];
	noindex: boolean;
	images: Array<{ src: string | null; alt: string | null }>;
	internalLinks: string[];
	structuredTypes: string[];
	structuredDataErrors: string[];
	/** Main content text with navigation and footer removed, one line per block. */
	text: string;
	headings: string[];
	fields: Array<{ path: string; value: string }>;
}

export interface AuditPageSource {
	pageId: string;
	versionId: string | null;
	url: string;
	html: string;
	parsed: ParsedPage | null;
	allowedHosts: readonly string[];
	isHome: boolean;
	keySection: boolean;
}

const NON_CONTENT = "script, style, noscript, template, header, footer, nav, form";

function inline(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function typeNames(value: unknown): string[] {
	if (typeof value === "string") return [value.replace(/^https?:\/\/schema\.org\//i, "")];
	if (Array.isArray(value)) return value.flatMap(typeNames);
	return [];
}

/** Types anywhere in a JSON-LD document, nested entities and `@graph` members included. */
function collectTypes(node: unknown, into: Set<string>, depth = 0): void {
	if (depth > 12 || node === null || typeof node !== "object") return;
	if (Array.isArray(node)) {
		for (const entry of node) collectTypes(entry, into, depth + 1);
		return;
	}
	const record = node as Record<string, unknown>;
	for (const type of typeNames(record["@type"])) into.add(type);
	for (const [key, value] of Object.entries(record)) {
		if (key !== "@type" && key !== "@context") collectTypes(value, into, depth + 1);
	}
}

function readStructuredData($: cheerio.CheerioAPI): { types: string[]; errors: string[] } {
	const types = new Set<string>();
	const errors: string[] = [];
	$('script[type="application/ld+json" i]').each((index, element) => {
		const raw = $(element).text().trim();
		if (!raw) return;
		try {
			collectTypes(JSON.parse(raw), types);
		} catch (error) {
			errors.push(`第 ${index + 1} 段 JSON-LD：${(error as Error).message.slice(0, 120)}`);
		}
	});
	$("[itemtype]").each((_, element) => {
		for (const itemType of ($(element).attr("itemtype") ?? "").split(/\s+/)) {
			const name = itemType.split("/").filter(Boolean).at(-1);
			if (name) types.add(name);
		}
	});
	return { types: [...types], errors };
}

function readLinks($: cheerio.CheerioAPI, pageUrl: string, allowedHosts: readonly string[]): string[] {
	const baseHref = $("base[href]").attr("href");
	const base = baseHref ? (normalizeUrl(baseHref, pageUrl) ?? pageUrl) : pageUrl;
	const links = new Set<string>();
	$("a[href], area[href]").each((_, element) => {
		const href = ($(element).attr("href") ?? "").trim();
		if (!href || href.startsWith("#") || /^(javascript|mailto|tel|data|sms):/i.test(href)) return;
		const url = normalizeUrl(href, base);
		if (!url || url === pageUrl) return;
		const host = new URL(url).hostname;
		if (isAllowedHost(host, allowedHosts)) links.add(url);
	});
	return [...links];
}

function bodyImages($: cheerio.CheerioAPI): AuditPageFacts["images"] {
	const root = $("body").clone();
	root.find(NON_CONTENT).remove();
	return root
		.find("img")
		.toArray()
		.map((image) => ({
			src: $(image).attr("src")?.trim() || $(image).attr("data-src")?.trim() || null,
			alt: inline($(image).attr("alt") ?? "") || null,
		}));
}

function bodyText($: cheerio.CheerioAPI): string {
	const root = $("body").clone();
	root.find(NON_CONTENT).remove();
	return inline(root.text());
}

function fieldValue(value: ParsedPage["fields"][number]["value"]): string | null {
	if (value === null) return null;
	const text = Array.isArray(value)
		? value.map((entry) => (Array.isArray(entry) ? entry.join(" ") : entry)).join(" ")
		: value;
	return inline(text) || null;
}

function readTitle($: cheerio.CheerioAPI): string | null {
	const headTitle = $("head > title").first();
	return inline((headTitle.length ? headTitle : $("title").first()).text()) || null;
}

/** A logo image inside the H1 still counts as a heading; an empty H1 does not. */
function readH1s($: cheerio.CheerioAPI): string[] {
	return $("h1")
		.toArray()
		.filter((element) => inline($(element).text()) || $(element).find("img").length > 0)
		.map((element) => inline($(element).text()) || inline($(element).find("img").first().attr("alt") ?? ""));
}

function readCanonicals($: cheerio.CheerioAPI, pageUrl: string) {
	const canonicals = new Set<string>();
	const invalidCanonicals: string[] = [];
	for (const element of $('link[rel~="canonical" i]').toArray()) {
		const href = ($(element).attr("href") ?? "").trim();
		const resolved = href ? normalizeUrl(href, pageUrl) : null;
		if (resolved) canonicals.add(resolved);
		else invalidCanonicals.push(href);
	}
	return { canonicals: [...canonicals], invalidCanonicals };
}

/**
 * Reads the audit facts from stored evidence only. The raw HTML answers questions
 * about markup (title, meta, headings, links, structured data); the parse answers
 * what the page is and what its main content says, with the site chrome removed.
 */
export function extractAuditFacts(source: AuditPageSource): AuditPageFacts {
	const $ = cheerio.load(source.html);
	const { parsed } = source;
	const robots = ($('meta[name="robots" i]').attr("content") ?? "").toLowerCase();
	const { canonicals, invalidCanonicals } = readCanonicals($, source.url);
	const structured = readStructuredData($);

	return {
		pageId: source.pageId,
		versionId: source.versionId,
		url: source.url,
		isHome: source.isHome,
		keySection: source.keySection,
		category: parsed?.category ?? null,
		categoryLabel: parsed?.categoryLabel ?? null,
		role: parsed?.role ?? null,
		entityKind: parsed?.entityKind ?? null,
		htmlTitle: readTitle($),
		metaDescription: inline($('meta[name="description" i]').attr("content") ?? "") || null,
		h1s: readH1s($),
		canonicals,
		invalidCanonicals,
		noindex: /\b(noindex|none)\b/.test(robots),
		images: parsed ? parsed.images.map((image) => ({ src: image.src, alt: image.alt })) : bodyImages($),
		internalLinks: readLinks($, source.url, source.allowedHosts),
		structuredTypes: structured.types,
		structuredDataErrors: structured.errors,
		text: parsed ? parsed.text : bodyText($),
		headings: parsed?.headings ?? [],
		fields: (parsed?.fields ?? []).flatMap((field) => {
			const value = fieldValue(field.value);
			return value ? [{ path: field.path, value }] : [];
		}),
	};
}
