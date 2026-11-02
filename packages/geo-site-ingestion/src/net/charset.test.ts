import { describe, expect, it } from "vitest";
import { decodeHtml, decodeSitemap, decodeStoredHtml } from "./charset";

/** Bytes for 示例电气 and 开关柜 in each legacy encoding, so the tests need no encoder. */
const GBK_NAME = Uint8Array.from([0xca, 0xbe, 0xc0, 0xfd, 0xb5, 0xe7, 0xc6, 0xf8]);
const BIG5_NAME = Uint8Array.from([0xa5, 0xdc, 0xa8, 0xd2, 0xb9, 0x71, 0xae, 0xf0]);

function page(...parts: Array<string | Uint8Array>): Uint8Array {
	const encoder = new TextEncoder();
	const chunks = parts.map((part) => (typeof part === "string" ? encoder.encode(part) : part));
	const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.length;
	}
	return bytes;
}

describe("decodeHtml", () => {
	it.each([
		['<meta charset="gbk">'],
		["<meta charset=gb2312>"],
		['<meta http-equiv="Content-Type" content="text/html; charset=GB2312">'],
		["<META CONTENT='text/html; charset=gbk' HTTP-EQUIV='content-type'>"],
	])("reads a page declared only by %s", (tag) => {
		const decoded = decodeHtml(page(`<html><head>${tag}<title>`, GBK_NAME, "</title>"), null);
		expect(decoded.text).toContain("示例电气");
		expect(decoded.charset).toBe("gbk");
	});

	it("reads GB18030 and Big5", () => {
		expect(decodeHtml(page('<meta charset="gb18030">', GBK_NAME), null).text).toContain("示例电气");
		expect(decodeHtml(page('<meta charset="big5">', BIG5_NAME), null).text).toContain("示例電氣");
	});

	it("gives the byte-order mark priority over the header and the header over the document", () => {
		const utf8 = new TextEncoder().encode("示例电气");
		const bom = Uint8Array.from([0xef, 0xbb, 0xbf]);
		expect(decodeHtml(page(bom, '<meta charset="gbk">', utf8), "big5")).toMatchObject({ charset: "utf-8" });
		expect(decodeHtml(page(bom, utf8), null).text).toBe("示例电气");
		expect(decodeHtml(page('<meta charset="big5">', GBK_NAME), "gbk").charset).toBe("gbk");
	});

	it("does not take a declaration from a comment or from ordinary text", () => {
		expect(decodeHtml(page("<!-- <meta charset=big5> --><p>", "电气"), null).charset).toBe("utf-8");
		expect(decodeHtml(page('<meta name="description" content="charset=big5"><p>', "电气"), null).charset).toBe("utf-8");
	});

	it("falls through a header the bytes contradict to what the page declares", () => {
		const decoded = decodeHtml(page('<meta charset="gbk"><title>', GBK_NAME), "utf-8");
		expect(decoded).toMatchObject({ charset: "gbk" });
		expect(decoded.text).toContain("示例电气");
	});

	it("recognizes undeclared GBK, and keeps UTF-8 with one stray byte as UTF-8", () => {
		expect(decodeHtml(page("<title>", GBK_NAME, GBK_NAME, "</title>"), null).text).toContain("示例电气示例电气");
		const damaged = page("电气".repeat(50), Uint8Array.from([0xff]), "<p>");
		const decoded = decodeHtml(damaged, "utf-8");
		expect(decoded.charset).toBe("utf-8");
		expect(decoded.text).toContain("电气电气");
	});

	it("ignores an unknown label and a meta claim of UTF-16 in ASCII-readable bytes", () => {
		expect(decodeHtml(page("电气"), "no-such-charset").charset).toBe("utf-8");
		expect(decodeHtml(page('<meta charset="utf-16"><p>', "电气"), null).text).toContain("电气");
	});

	it("reads back a snapshot stored under the charset it was detected with, or under a stale UTF-8 stamp", () => {
		const body = page('<meta charset="gbk"><title>', GBK_NAME);
		const { charset } = decodeHtml(body, null);
		expect(decodeStoredHtml(body, `text/html; charset=${charset}`)).toContain("示例电气");
		expect(decodeStoredHtml(body, "text/html; charset=utf-8")).toContain("示例电气");
		expect(decodeStoredHtml(body, null)).toContain("示例电气");
	});

	it("honours the encoding a sitemap's XML declaration names", () => {
		const body = page('<?xml version="1.0" encoding="GBK"?><urlset>', GBK_NAME, "</urlset>");
		expect(decodeSitemap({ body, mimeType: "application/xml", charset: null }, 1024)).toContain("示例电气");
	});
});
