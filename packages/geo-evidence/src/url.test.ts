import { describe, expect, it } from "vitest";
import { hostOf, normalizeUrl } from "./url";

describe("normalizeUrl", () => {
	it("gives the same identity to the spellings of one page", () => {
		const expected = "https://www.example-electric.test/products/a?model=1&page=2";
		for (const input of [
			"https://www.example-electric.test/products/a?model=1&page=2",
			"HTTPS://WWW.Example-Electric.test:443/products/a/?page=2&model=1",
			"https://www.example-electric.test/products//a?page=2&model=1&utm_source=x#top",
			"https://user:pass@www.example-electric.test/products/a?gclid=abc&model=1&page=2",
		]) {
			expect(normalizeUrl(input)).toBe(expected);
		}
	});

	it("keeps the root path and resolves a relative link against its page", () => {
		expect(normalizeUrl("http://www.example-electric.test")).toBe("http://www.example-electric.test/");
		expect(normalizeUrl("../b.html", "http://www.example-electric.test/x/y/z.html")).toBe(
			"http://www.example-electric.test/x/b.html",
		);
	});

	it("keeps http and https, and www and the bare host, apart", () => {
		expect(normalizeUrl("http://example-electric.test/")).not.toBe(normalizeUrl("https://example-electric.test/"));
		expect(normalizeUrl("https://www.example-electric.test/")).not.toBe(normalizeUrl("https://example-electric.test/"));
	});

	it("collapses dot segments and decodes only what never needed encoding", () => {
		expect(normalizeUrl("http://www.example-electric.test/a/%2e%2e/b/./c")).toBe("http://www.example-electric.test/b/c");
		expect(normalizeUrl("http://www.example-electric.test/%7Euser/%e5%bc%80%2F")).toBe(
			"http://www.example-electric.test/~user/%E5%BC%80%2F",
		);
	});

	it("refuses anything that is not a web URL", () => {
		for (const input of ["javascript:alert(1)", "file:///etc/passwd", "ftp://example-electric.test/", "not a url", ""]) {
			expect(normalizeUrl(input), input).toBeNull();
		}
	});
});

describe("hostOf", () => {
	it("answers the bare lower-case host", () => {
		expect(hostOf("https://WWW.Example-Electric.test:8443/a")).toBe("www.example-electric.test");
		expect(hostOf("https://www.example-electric.test./a")).toBe("www.example-electric.test");
		expect(hostOf("mailto:a@example-electric.test")).toBeNull();
	});
});
