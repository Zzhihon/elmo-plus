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
import { parserVersionOf, type SiteFieldRule, type SiteProfile } from "./profile";
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
	return clone
		.text()
		.split("\n")
		.map(inline)
		.filter(Boolean)
		.join("\n")
		.slice(0, MAX_TEXT);
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

function extractField($: cheerio.CheerioAPI, rule: SiteFieldRule, pageUrl: string): ParsedField {
	const base: Omit<ParsedField, "value" | "locator"> = {
		path: rule.path,
		label: rule.label ?? null,
		type: rule.type,
		claimType: rule.claimType ?? null,
		risk: rule.risk ?? null,
	};
	const match = firstMatch($, rule.selector);
	if (!match) return { ...base, value: null, locator: null };
	const { selector, elements } = match;
	const first = elements.first();
	const read = ($element: Selection) => (rule.attr ? ($element.attr(rule.attr) ?? "") : inline($element.text()));

	switch (rule.type) {
		case "multiline": {
			const text = applyPattern(blockText($, first), rule.pattern);
			return { ...base, value: text || null, locator: text ? locatorOf(selector, 0, text) : null };
		}
		case "date": {
			const raw = applyPattern(read(first), rule.pattern);
			const date = raw ? normalizeDate(raw) : null;
			return { ...base, value: date, locator: date ? locatorOf(selector, 0, raw ?? date) : null };
		}
		case "image":
		case "images": {
			const sources = elements
				.toArray()
				.map((element) => absolute(rule.attr ? ($(element).attr(rule.attr) ?? null) : imageSource($(element)), pageUrl))
				.filter((src): src is string => Boolean(src));
			const value = rule.type === "image" ? (sources[0] ?? null) : sources.length ? sources : null;
			return { ...base, value, locator: sources.length ? locatorOf(selector, 0, sources[0]) : null };
		}
		case "link": {
			const href = absolute(first.attr(rule.attr ?? "href") ?? null, pageUrl);
			return { ...base, value: href, locator: href ? locatorOf(selector, 0, href) : null };
		}
		case "list": {
			const items = elements
				.toArray()
				.map((element) => applyPattern(read($(element)), rule.pattern))
				.filter((item): item is string => Boolean(item));
			return {
				...base,
				value: items.length ? items : null,
				locator: items.length ? locatorOf(selector, 0, items.join("；")) : null,
			};
		}
		case "table": {
			const rows = tableRows($, first.is("table") ? first : first.find("table").first());
			return {
				...base,
				value: rows.length ? rows : null,
				locator: rows.length ? locatorOf(selector, 0, rows.map((row) => row.join(" | ")).join("\n")) : null,
			};
		}
		default: {
			const text = applyPattern(read(first), rule.pattern);
			return { ...base, value: text || null, locator: text ? locatorOf(selector, 0, text) : null };
		}
	}
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

function parsePage(html: string, url: string, profile: SiteProfile): ParseOutcome {
	const $ = cheerio.load(html);
	const page = emptyPage(url, profile);
	const category = categoryOf(url, profile, $);
	page.category = category?.key ?? null;
	page.categoryLabel = category?.label ?? null;
	page.entityKind = category?.entityKind ?? null;
	page.role = category?.role ?? null;
	page.metaDescription = inline($('meta[name="description" i]').attr("content") ?? "") || null;
	page.h1 = inline($("h1").first().text()) || null;
	page.lang = $("html").attr("lang")?.trim() || null;
	const canonical = $('link[rel~="canonical" i]').attr("href");
	page.canonical = canonical ? normalizeUrl(canonical, url) : null;

	page.fields = (category?.fields ?? []).map((rule) => extractField($, rule, url));

	if (profile.defaults.publishedAt) {
		const match = firstMatch($, profile.defaults.publishedAt.selector);
		const raw = match ? applyPattern(inline(match.elements.first().text()), profile.defaults.publishedAt.pattern) : null;
		page.publishedAt = raw ? normalizeDate(raw) : null;
	}
	const dateField = page.fields.find((field) => field.type === "date" && typeof field.value === "string");
	if (dateField) page.publishedAt = dateField.value as string;

	const titleMatch = firstMatch($, category?.title ?? profile.defaults.title);
	page.title = titleMatch ? inline(titleMatch.elements.first().text()) || null : null;

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
		.map((table): ParsedTable => {
			const caption = inline($(table).find("caption").first().text()) || null;
			return { caption, rows: tableRows($, $(table)) };
		})
		.filter((table) => table.rows.length > 0);
	const images = new Map<string, ParsedImage>();
	for (const image of root.find("img").toArray()) {
		const src = absolute(imageSource($(image)), url);
		if (src && !images.has(src)) images.set(src, { src, alt: inline($(image).attr("alt") ?? "") || null });
	}
	page.images = [...images.values()];

	if (!page.title) page.warnings.push("TITLE_MISSING");
	if (!page.text && page.images.length === 0) page.warnings.push("EMPTY_CONTENT");
	if (contentMatch === null) page.warnings.push("CONTENT_SELECTOR_MISSED");
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
