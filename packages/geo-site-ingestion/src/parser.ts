import { normalizeUrl } from "@workspace/geo-evidence";
import * as cheerio from "cheerio";
import type {
	FieldLocator,
	ParsedField,
	ParsedImage,
	ParsedPage,
	ParsedTable,
	ParseOutcome,
	SitePageParser,
} from "./contracts";
import { categoryOf } from "./discovery";
import {
	parserVersionOf,
	type SiteCategory,
	type SiteFieldRule,
	type SiteFieldType,
	type SiteProfile,
} from "./profile";
import { normalizeDate, truncate } from "./text";

type Selection = ReturnType<cheerio.CheerioAPI>;

const BLOCK_TAGS = new Set([
	"p",
	"div",
	"section",
	"article",
	"li",
	"dd",
	"dt",
	"tr",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"blockquote",
	"pre",
	"table",
	"ul",
	"ol",
	"dl",
	"figcaption",
]);

const MAX_TEXT = 200_000;
const QUOTE_LENGTH = 200;

function inline(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

/** Text with one line per block, so a diff of two versions lines up paragraph by paragraph. */
export function blockText($: cheerio.CheerioAPI, root: Selection): string {
	const clone = root.clone();
	clone.find("script, style, noscript, template").remove();
	clone.find("br").replaceWith("\n");
	clone.find("*").each((_, element) => {
		if ("tagName" in element && BLOCK_TAGS.has(element.tagName.toLowerCase())) {
			$(element).prepend("\n").append("\n");
		}
	});
	return clone.text().split("\n").map(inline).filter(Boolean).join("\n").slice(0, MAX_TEXT);
}

function firstMatch($: cheerio.CheerioAPI, selectors: readonly string[], root?: Selection) {
	for (const selector of selectors) {
		const found = root ? root.find(selector) : $(selector);
		const nonEmpty = found.filter((_, element) => inline($(element).text()).length > 0 || $(element).is("img, meta"));
		if (nonEmpty.length > 0) return { selector, elements: nonEmpty };
	}
	return null;
}

function imageSource($element: Selection): string | null {
	for (const attribute of ["src", "data-src", "data-original", "data-lazy-src"]) {
		const value = $element.attr(attribute)?.trim();
		if (value && !value.startsWith("data:")) return value;
	}
	return null;
}

function absolute(value: string | null, pageUrl: string): string | null {
	if (!value) return null;
	return normalizeUrl(value, pageUrl);
}

function applyPattern(value: string, pattern: string | undefined): string | null {
	if (!pattern) return value;
	const match = new RegExp(pattern).exec(value);
	if (!match) return null;
	return inline(match[1] ?? match[0]);
}

function tableRows($: cheerio.CheerioAPI, table: Selection): string[][] {
	return table
		.find("tr")
		.toArray()
		.map((row) =>
			$(row)
				.find("th, td")
				.toArray()
				.map((cell) => inline($(cell).text())),
		)
		.filter((cells) => cells.some(Boolean));
}

function locatorOf(selector: string, ordinal: number, quote: string): FieldLocator {
	return { selector, ordinal, quote: truncate(quote, QUOTE_LENGTH) };
}

interface FieldContext {
	$: cheerio.CheerioAPI;
	rule: SiteFieldRule;
	pageUrl: string;
	elements: Selection;
	first: Selection;
}

type Extracted = { value: ParsedField["value"]; quote: string | null };

function readText({ rule }: FieldContext, $element: Selection): string {
	return rule.attr ? ($element.attr(rule.attr) ?? "") : inline($element.text());
}

function textExtract(ctx: FieldContext): Extracted {
	const text = applyPattern(readText(ctx, ctx.first), ctx.rule.pattern) || null;
	return { value: text, quote: text };
}

function imageExtract(ctx: FieldContext): Extracted {
	const { $, rule, pageUrl } = ctx;
	const sources = ctx.elements
		.toArray()
		.map((element) => absolute(rule.attr ? ($(element).attr(rule.attr) ?? null) : imageSource($(element)), pageUrl))
		.filter((src): src is string => Boolean(src));
	if (sources.length === 0) return { value: null, quote: null };
	return { value: rule.type === "image" ? sources[0] : sources, quote: sources[0] };
}

const EXTRACTORS: Record<SiteFieldType, (ctx: FieldContext) => Extracted> = {
	text: textExtract,
	multiline: (ctx) => {
		const text = applyPattern(blockText(ctx.$, ctx.first), ctx.rule.pattern) || null;
		return { value: text, quote: text };
	},
	date: (ctx) => {
		const raw = applyPattern(readText(ctx, ctx.first), ctx.rule.pattern);
		const date = raw ? normalizeDate(raw) : null;
		return { value: date, quote: date ? (raw ?? date) : null };
	},
	image: imageExtract,
	images: imageExtract,
	link: (ctx) => {
		const href = absolute(ctx.first.attr(ctx.rule.attr ?? "href") ?? null, ctx.pageUrl);
		return { value: href, quote: href };
	},
	list: (ctx) => {
		const items = ctx.elements
			.toArray()
			.map((element) => applyPattern(readText(ctx, ctx.$(element)), ctx.rule.pattern))
			.filter((item): item is string => Boolean(item));
		return items.length ? { value: items, quote: items.join("；") } : { value: null, quote: null };
	},
	table: (ctx) => {
		const rows = tableRows(ctx.$, ctx.first.is("table") ? ctx.first : ctx.first.find("table").first());
		return rows.length
			? { value: rows, quote: rows.map((row) => row.join(" | ")).join("\n") }
			: { value: null, quote: null };
	},
};

function extractField($: cheerio.CheerioAPI, rule: SiteFieldRule, pageUrl: string): ParsedField {
	const base = {
		path: rule.path,
		label: rule.label ?? null,
		type: rule.type,
		claimType: rule.claimType ?? null,
		risk: rule.risk ?? null,
	};
	const match = firstMatch($, rule.selector);
	if (!match) return { ...base, value: null, locator: null };
	const { value, quote } = EXTRACTORS[rule.type]({
		$,
		rule,
		pageUrl,
		elements: match.elements,
		first: match.elements.first(),
	});
	return { ...base, value, locator: quote ? locatorOf(match.selector, 0, quote) : null };
}

function emptyPage(url: string, profile: SiteProfile): ParsedPage {
	return {
		parserVersion: parserVersionOf(profile),
		url,
		category: null,
		categoryLabel: null,
		entityKind: null,
		role: null,
		title: null,
		metaDescription: null,
		h1: null,
		canonical: null,
		lang: null,
		publishedAt: null,
		text: "",
		headings: [],
		tables: [],
		images: [],
		fields: [],
		warnings: [],
	};
}

function readMeta($: cheerio.CheerioAPI, page: ParsedPage, url: string, profile: SiteProfile): void {
	page.metaDescription = inline($('meta[name="description" i]').attr("content") ?? "") || null;
	page.h1 = inline($("h1").first().text()) || null;
	page.lang = $("html").attr("lang")?.trim() || null;
	const canonical = $('link[rel~="canonical" i]').attr("href");
	page.canonical = canonical ? normalizeUrl(canonical, url) : null;
	if (profile.defaults.publishedAt) {
		const match = firstMatch($, profile.defaults.publishedAt.selector);
		const raw = match
			? applyPattern(inline(match.elements.first().text()), profile.defaults.publishedAt.pattern)
			: null;
		page.publishedAt = raw ? normalizeDate(raw) : null;
	}
	const dateField = page.fields.find((field) => field.type === "date" && typeof field.value === "string");
	if (dateField) page.publishedAt = dateField.value as string;
}

function readContent(
	$: cheerio.CheerioAPI,
	page: ParsedPage,
	url: string,
	profile: SiteProfile,
	category: SiteCategory | null,
): boolean {
	const removals = [...profile.defaults.remove, ...(category?.remove ?? [])];
	const contentMatch = firstMatch($, category?.content ?? profile.defaults.content);
	const root = contentMatch ? contentMatch.elements.first().clone() : $("body").clone();
	for (const selector of removals) root.find(selector).remove();

	page.text = blockText($, root);
	page.headings = root
		.find("h1, h2, h3, h4, h5, h6")
		.toArray()
		.map((heading) => inline($(heading).text()))
		.filter(Boolean);
	page.tables = root
		.find("table")
		.toArray()
		.map(
			(table): ParsedTable => ({
				caption: inline($(table).find("caption").first().text()) || null,
				rows: tableRows($, $(table)),
			}),
		)
		.filter((table) => table.rows.length > 0);
	const images = new Map<string, ParsedImage>();
	for (const image of root.find("img").toArray()) {
		const src = absolute(imageSource($(image)), url);
		if (src && !images.has(src)) images.set(src, { src, alt: inline($(image).attr("alt") ?? "") || null });
	}
	page.images = [...images.values()];
	return contentMatch !== null;
}

function parsePage(html: string, url: string, profile: SiteProfile): ParseOutcome {
	const $ = cheerio.load(html);
	const page = emptyPage(url, profile);
	const category = categoryOf(url, profile, $);
	page.category = category?.key ?? null;
	page.categoryLabel = category?.label ?? null;
	page.entityKind = category?.entityKind ?? null;
	page.role = category?.role ?? null;
	page.fields = (category?.fields ?? []).map((rule) => extractField($, rule, url));
	readMeta($, page, url, profile);

	const titleMatch = firstMatch($, category?.title ?? profile.defaults.title);
	page.title = titleMatch ? inline(titleMatch.elements.first().text()) || null : null;
	const contentFound = readContent($, page, url, profile, category);

	if (!page.title) page.warnings.push("TITLE_MISSING");
	if (!page.text && page.images.length === 0) page.warnings.push("EMPTY_CONTENT");
	if (!contentFound) page.warnings.push("CONTENT_SELECTOR_MISSED");
	const missing = (category?.fields ?? [])
		.filter((rule, index) => rule.required && page.fields[index].value === null)
		.map((rule) => rule.path);
	if (missing.length > 0) {
		return {
			status: "FAILED",
			page,
			errorCode: "REQUIRED_FIELD_MISSING",
			message: `必填字段未解析到：${missing.join("、")}`,
		};
	}
	return { status: "PARSED", page };
}

export function createSitePageParser(profile: SiteProfile): SitePageParser {
	return {
		version: parserVersionOf(profile),
		parse(html, url, activeProfile = profile) {
			try {
				return parsePage(html, url, activeProfile);
			} catch (error) {
				return { status: "FAILED", page: null, errorCode: "PARSER_ERROR", message: (error as Error).message };
			}
		},
	};
}

export function parseSitePage(html: string, url: string, profile: SiteProfile): ParseOutcome {
	return createSitePageParser(profile).parse(html, url, profile);
}
