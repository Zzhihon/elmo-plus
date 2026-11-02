import * as cheerio from "cheerio";

const DANGEROUS_ELEMENTS =
	"script, iframe, frame, frameset, object, embed, applet, form, input, button, textarea, select, base, link, meta, noscript, template, portal, svg script";

const URL_ATTRIBUTES = ["href", "src", "action", "formaction", "xlink:href", "poster", "background", "srcset", "data"];

/**
 * Locks the snapshot down from inside as well: no script, no network, no forms,
 * no navigation of the parent. The page is shown as captured text and layout only.
 */
export const SNAPSHOT_VIEW_CSP =
	"default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'; base-uri 'none'";

/** Event handlers and every URL-bearing attribute go; a link keeps its target only as inert data. */
function scrubAttributes(attribs: Record<string, string>): void {
	for (const name of Object.keys(attribs)) {
		const lower = name.toLowerCase();
		const value = attribs[name];
		const dangerousStyle = lower === "style" && /url\s*\(|expression\s*\(|@import/i.test(value);
		if (lower === "href" && !/^(javascript|data|vbscript):/i.test(value.trim()))
			attribs["data-original-href"] = value.trim();
		if (lower.startsWith("on") || URL_ATTRIBUTES.includes(lower) || dangerousStyle) delete attribs[name];
	}
}

/**
 * Turns a stored page into something safe to show inside `<iframe sandbox srcdoc>`.
 * The sandbox already blocks script; this removes active content and every
 * external reference too, so a hostile snapshot can neither run nor call home,
 * and the policy meta tag repeats both rules for the browser.
 */
export function renderSnapshotForViewing(html: string): string {
	const $ = cheerio.load(html);
	$(DANGEROUS_ELEMENTS).remove();
	$("*")
		.contents()
		.filter((_, node) => node.type === "comment")
		.remove();
	$("*").each((_, element) => {
		if ("attribs" in element) scrubAttributes(element.attribs);
	});
	$("style").each((_, element) => {
		const css = $(element).html() ?? "";
		$(element).text(css.replace(/@import[^;]*;?/gi, "").replace(/url\s*\([^)]*\)/gi, "none"));
	});
	$("img").each((_, element) => {
		const $image = $(element);
		const label = $image.attr("alt") || "图片";
		$image.replaceWith(`<span class="geo-snapshot-image">[${escapeText(label)}]</span>`);
	});
	const head = $("head");
	head.prepend(
		`<meta http-equiv="Content-Security-Policy" content="${SNAPSHOT_VIEW_CSP}"><meta charset="utf-8"><style>.geo-snapshot-image{display:inline-block;padding:2px 6px;margin:2px;border:1px dashed #bbb;color:#888;font-size:12px}</style>`,
	);
	return `<!DOCTYPE html>${$.html()}`;
}

function escapeText(value: string): string {
	return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}
