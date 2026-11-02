import { normalizeUrl } from "@workspace/geo-evidence";
import * as cheerio from "cheerio";
import type { DiscoveredLink, DiscoveredLinkKind, PageDiscovery, SiteDiscoveryAdapter } from "./contracts";
import type { SiteCategory, SiteProfile } from "./profile";

const PAGINATION_TEXT = /^(\d{1,4}|下一页|上一页|首页|尾页|末页|下页|上页|next|prev|previous|last|first|»|«|>|<|>>|<<)$/i;
const PAGINATION_CONTAINER = /(^|[\s_-])(page|pages|pager|pagination|paging|page_list|pagelist)([\s_-]|$)/i;

function cleanText(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function robotsDirectives(content: string | undefined): Set<string> {
	return new Set(
		(content ?? "")
			.toLowerCase()
			.split(",")
			.map((part) => part.trim()),
	);
}

function pathAndQueryOf(url: string): string {
	const parsed = new URL(url);
	return `${parsed.pathname}${parsed.search}`;
}

export function isAssetUrl(url: string, profile: SiteProfile): boolean {
	const path = new URL(url).pathname.toLowerCase();
	return profile.assets.extensions.some((extension) => path.endsWith(extension));
}

function isPaginationUrl(url: string, profile: SiteProfile): boolean {
	const target = pathAndQueryOf(url);
	return profile.pagination.patterns.some((pattern) => new RegExp(pattern).test(target));
}

/** The first category whose URL pattern matches and, if it asks, whose marker element is present. */
export function categoryOf(url: string, profile: SiteProfile, $?: cheerio.CheerioAPI): SiteCategory | null {
	const target = pathAndQueryOf(url);
	for (const category of profile.categories) {
		const urlMatches =
			category.urlPatterns.length === 0 || category.urlPatterns.some((pattern) => new RegExp(pattern).test(target));
		if (!urlMatches) continue;
		if (category.requireSelector?.length) {
			if (!$) continue;
			if (!category.requireSelector.some((selector) => $(selector).length > 0)) continue;
		}
		if (category.urlPatterns.length === 0 && !category.requireSelector?.length) continue;
		return category;
	}
	return null;
}

export const siteDiscovery: SiteDiscoveryAdapter = {
	discover(html, pageUrl, profile) {
		const $ = cheerio.load(html);
		const base = $("base[href]").attr("href");
		const baseUrl = base ? (normalizeUrl(base, pageUrl) ?? pageUrl) : pageUrl;
		const meta = robotsDirectives($('meta[name="robots" i]').attr("content"));
		const canonicalHref = $('link[rel~="canonical" i]').attr("href");
		const canonical = canonicalHref ? normalizeUrl(canonicalHref, baseUrl) : null;

		const seen = new Map<string, DiscoveredLink>();
		$("a[href], area[href]").each((_, element) => {
			const $element = $(element);
			const href = ($element.attr("href") ?? "").trim();
			if (!href || href.startsWith("#") || /^(javascript|mailto|tel|data|sms):/i.test(href)) return;
			const url = normalizeUrl(href, baseUrl);
			if (!url) return;
			const rel = ($element.attr("rel") ?? "").toLowerCase().split(/\s+/);
			const text = cleanText($element.text()).slice(0, 120);
			const inPager = $element.parents().toArray().some((parent) => PAGINATION_CONTAINER.test($(parent).attr("class") ?? ""));
			let kind: DiscoveredLinkKind = "PAGE";
			if (isAssetUrl(url, profile)) kind = "ASSET";
			else if (
				isPaginationUrl(url, profile) ||
				rel.includes("next") ||
				rel.includes("prev") ||
				(inPager && PAGINATION_TEXT.test(text))
			) {
				kind = "PAGINATION";
			}
			const link: DiscoveredLink = { url, kind, nofollow: rel.includes("nofollow"), text };
			const existing = seen.get(url);
			if (!existing || (existing.nofollow && !link.nofollow)) seen.set(url, link);
		});
		$('link[rel~="next" i][href], link[rel~="prev" i][href]').each((_, element) => {
			const url = normalizeUrl($(element).attr("href") ?? "", baseUrl);
			if (url && !seen.has(url)) seen.set(url, { url, kind: "PAGINATION", nofollow: false, text: "" });
		});

		const title = cleanText($("title").first().text()) || null;
		return {
			links: [...seen.values()],
			canonical,
			metaNoindex: meta.has("noindex") || meta.has("none"),
			metaNofollow: meta.has("nofollow") || meta.has("none"),
			title,
		} satisfies PageDiscovery;
	},

	sitemapUrls(xml, sitemapUrl) {
		const $ = cheerio.load(xml, { xml: true });
		const read = (selector: string) =>
			$(selector)
				.toArray()
				.map((element) => normalizeUrl(cleanText($(element).text()), sitemapUrl))
				.filter((url): url is string => Boolean(url));
		return { pages: read("urlset > url > loc"), sitemaps: read("sitemapindex > sitemap > loc") };
	},
};
