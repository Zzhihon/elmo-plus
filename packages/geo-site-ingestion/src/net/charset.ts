import { gunzipSync } from "node:zlib";
import { parseContentType } from "./safe-fetch";

/** The window browsers scan for a declaration, widened because old templates put scripts before their meta tags. */
const PRESCAN_BYTES = 4096;
const META_TAG = /<meta\b[^>]*>/gi;
const COMMENT = /<!--[\s\S]*?(-->|$)/g;
const XML_ENCODING = /^\s*<\?xml\b[^>]*?\bencoding\s*=\s*["']([A-Za-z0-9._:-]+)["']/i;
/** Below this share of broken characters a page is UTF-8 with a stray byte, not another encoding. */
const STRAY_BYTE_RATIO = 0.05;

function normalizedLabel(label: string | null | undefined): string | null {
	if (!label) return null;
	try {
		return new TextDecoder(label.trim().toLowerCase()).encoding;
	} catch {
		return null;
	}
}

const ATTRIBUTE = /([^\s=>/"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

function attributesOf(tag: string): Map<string, string> {
	const attributes = new Map<string, string>();
	for (const match of tag.replace(/^<meta\b/i, "").matchAll(ATTRIBUTE)) {
		attributes.set(match[1].toLowerCase(), match[2] ?? match[3] ?? match[4] ?? "");
	}
	return attributes;
}

/** A pre-parse in the spirit of WHATWG: comments do not count, and http-equiv only counts when it names Content-Type. */
function declaredInDocument(body: Uint8Array): string | null {
	const head = new TextDecoder("latin1").decode(body.subarray(0, PRESCAN_BYTES));
	const xml = XML_ENCODING.exec(head)?.[1];
	if (xml) return xml;
	for (const [tag] of head.replace(COMMENT, "").matchAll(META_TAG)) {
		const attributes = attributesOf(tag);
		const direct = attributes.get("charset");
		if (direct) return direct;
		if (attributes.get("http-equiv")?.trim().toLowerCase() === "content-type") {
			const fromContent = /charset\s*=\s*["']?\s*([^\s"';]+)/i.exec(attributes.get("content") ?? "")?.[1];
			if (fromContent) return fromContent;
		}
	}
	return null;
}

function bomOf(body: Uint8Array): { encoding: string; length: number } | null {
	if (body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) return { encoding: "utf-8", length: 3 };
	if (body[0] === 0xff && body[1] === 0xfe) return { encoding: "utf-16le", length: 2 };
	if (body[0] === 0xfe && body[1] === 0xff) return { encoding: "utf-16be", length: 2 };
	return null;
}

function decodeStrict(body: Uint8Array, encoding: string): string | null {
	try {
		return new TextDecoder(encoding, { fatal: true }).decode(body);
	} catch {
		return null;
	}
}

function isMostlyUtf8(text: string): boolean {
	let nonAscii = 0;
	let broken = 0;
	for (const character of text) {
		if (character.charCodeAt(0) < 0x80) continue;
		nonAscii++;
		if (character === "�") broken++;
	}
	return broken <= nonAscii * STRAY_BYTE_RATIO;
}

/**
 * Byte-order mark, then the HTTP header, then what the document itself declares,
 * as browsers order them. A declaration the bytes contradict gives way to the next
 * one, because servers often stamp a default charset on pages authored in another,
 * and bytes that declare nothing and are not UTF-8 are taken as GB18030, a superset
 * of the GBK and GB2312 that older Chinese sites still serve.
 */
export function decodeHtml(body: Uint8Array, headerCharset: string | null): { text: string; charset: string } {
	const bom = bomOf(body);
	if (bom) {
		return { text: new TextDecoder(bom.encoding).decode(body.subarray(bom.length)), charset: bom.encoding };
	}
	// A meta tag readable as ASCII cannot really be in UTF-16, whatever it claims (WHATWG prescan rule).
	const inDocument = normalizedLabel(declaredInDocument(body))?.replace(/^utf-16(le|be)$/, "utf-8") ?? null;
	const declared = [...new Set([normalizedLabel(headerCharset), inDocument])].filter(
		(label): label is string => label !== null,
	);
	for (const encoding of declared) {
		const text = decodeStrict(body, encoding);
		if (text !== null) return { text, charset: encoding };
	}
	const asUtf8 = new TextDecoder("utf-8").decode(body);
	if (isMostlyUtf8(asUtf8)) return { text: asUtf8, charset: "utf-8" };
	const named = declared.find((encoding) => encoding !== "utf-8");
	if (named) return { text: new TextDecoder(named).decode(body), charset: named };
	return { text: new TextDecoder("gb18030").decode(body), charset: "gb18030" };
}

/** Stored snapshots carry the charset they were decoded with in their content type. */
export function decodeStoredHtml(body: Uint8Array, contentType: string | null | undefined): string {
	return decodeHtml(body, parseContentType(contentType ?? undefined).charset).text;
}

export function decodeSitemap(
	result: { body: Uint8Array; mimeType: string | null; charset: string | null },
	maxBytes: number,
): string {
	const isGzip = result.mimeType === "application/gzip" || result.mimeType === "application/x-gzip";
	const body = isGzip ? gunzipSync(result.body, { maxOutputLength: maxBytes }) : result.body;
	return decodeHtml(body, isGzip ? null : result.charset).text;
}
