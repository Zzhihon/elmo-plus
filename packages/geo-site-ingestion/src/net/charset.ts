const META_CHARSET = /<meta[^>]+charset\s*=\s*["']?\s*([A-Za-z0-9_-]+)/i;

function decoderFor(label: string | null | undefined): TextDecoder | null {
	if (!label) return null;
	try {
		return new TextDecoder(label.trim().toLowerCase());
	} catch {
		return null;
	}
}

/**
 * Chinese sites still serve GBK/GB2312 pages, often declared only in a meta tag,
 * so the header, a byte-order mark and the first bytes of the document are all
 * consulted before falling back to UTF-8.
 */
export function decodeHtml(body: Uint8Array, headerCharset: string | null): { text: string; charset: string } {
	if (body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) {
		return { text: new TextDecoder("utf-8").decode(body.subarray(3)), charset: "utf-8" };
	}
	const fromHeader = decoderFor(headerCharset);
	if (fromHeader) return { text: fromHeader.decode(body), charset: fromHeader.encoding };
	const head = new TextDecoder("latin1").decode(body.subarray(0, 4096));
	const fromMeta = decoderFor(META_CHARSET.exec(head)?.[1]);
	if (fromMeta) return { text: fromMeta.decode(body), charset: fromMeta.encoding };
	return { text: new TextDecoder("utf-8").decode(body), charset: "utf-8" };
}
