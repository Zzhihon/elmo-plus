import { createHash } from "node:crypto";
import * as cheerio from "cheerio";
import type { SiteProfile } from "./profile";

export function sha256Hex(value: Uint8Array | string): string {
	return createHash("sha256").update(value).digest("hex");
}

/**
 * The identity of a page's content. Scripts, comments, hidden form tokens and
 * whatever the profile marks as volatile (view counters, rotating banners) are
 * dropped first, so a page that only changed its counter is "unchanged" and gets
 * no new version. The raw bytes are still stored under their own hash.
 */
export function contentHashOf(html: string, profile: Pick<SiteProfile, "volatile">): string {
	const $ = cheerio.load(html);
	$("script, style, noscript, template, input[type='hidden' i], meta[name='csrf-token' i]").remove();
	$("*")
		.contents()
		.filter((_, node) => node.type === "comment")
		.remove();
	for (const selector of profile.volatile.selectors) $(selector).remove();
	let normalized = ($("body").html() ?? $.html()).replace(/\s+/g, " ");
	for (const pattern of profile.volatile.patterns) normalized = normalized.replace(new RegExp(pattern, "g"), "");
	const title = $("title").text().replace(/\s+/g, " ").trim();
	return sha256Hex(`${title}\n${normalized.trim()}`);
}
