import { describe, expect, it } from "vitest";
import { decideVersion } from "./crawl-policy";
import { siteDiscovery } from "./discovery";
import { contentHashOf } from "./hash";
import { siteContentNormalizer, siteKnowledgeMapper } from "./knowledge";
import { parseSitePage } from "./parser";
import { parserVersionOf, parseSiteProfile, type SiteProfileInput } from "./profile";
import { renderSnapshotForViewing } from "./snapshot-view";

const BASE = "http://www.example-electric.test";

const profileInput: SiteProfileInput = {
	id: "example-electric",
	version: 3,
	volatile: { selectors: [".visits"], patterns: ["浏览\\s*\\d+\\s*次"] },
	pagination: { patterns: ["_p\\d+\\.html$"] },
	defaults: { title: ["h1", "title"], content: [".main", "body"], remove: ["script", "style", ".nav", ".footer"] },
	categories: [
		{
			key: "product",
			label: "产品中心",
			urlPatterns: ["^/products/[a-z0-9-]+\\.html$"],
			requireSelector: [".product-name"],
			entityKind: "PRODUCT",
			keySection: true,
			title: [".product-name"],
			content: [".product-body"],
			fields: [
				{
					path: "model",
					label: "型号",
					selector: [".product-name"],
					pattern: "^([A-Z0-9-]+)",
					required: true,
					claimType: "MODEL",
				},
				{
					path: "summary",
					label: "产品概况",
					selector: [".product-summary"],
					type: "multiline",
					claimType: "DESCRIPTION",
				},
				{ path: "ratedVoltage", label: "额定电压", selector: [".spec-voltage"], claimType: "TECH_PARAMETER" },
				{ path: "images", selector: [".gallery img"], type: "images" },
				{ path: "parameters", selector: [".spec-table"], type: "table" },
			],
		},
		{
			key: "case",
			label: "工程案例",
			urlPatterns: ["^/cases/\\d+\\.html$"],
			entityKind: "CASE",
			title: [".case-title"],
			content: [".case-body"],
			fields: [{ path: "publishedAt", selector: [".case-meta"], type: "date", pattern: "发布时间[:：]\\s*([0-9-]+)" }],
		},
		{ key: "case-list", label: "案例列表", urlPatterns: ["^/cases(_p\\d+)?\\.html$"], role: "listing" },
	],
};
const profile = parseSiteProfile(profileInput);

const productPage = (visits: number, voltage = "12kV") => `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>XG-12 高压开关柜 - 示例电气</title>
<meta name="description" content="示例电气高压开关柜">
<script>window.token = "${visits}";</script></head>
<body>
<div class="nav"><a href="/">首页</a><a href="/cases.html">案例</a><a href="http://partner.test/">合作伙伴</a></div>
<div class="main">
  <div class="product-name">XG-12 铠装移开式高压开关柜</div>
  <div class="visits">浏览 ${visits} 次</div>
  <div class="gallery"><img src="/upload/xg12-front.jpg" alt="正面"><img data-src="/upload/xg12-side.jpg"></div>
  <div class="product-body">
    <div class="product-summary"><p>适用于三相交流 50Hz 电网。</p><p>用于接受和分配电能。</p></div>
    <p class="spec-voltage">${voltage}</p>
    <table class="spec-table"><tr><th>项目</th><th>参数</th></tr><tr><td>额定电流</td><td>1250A</td></tr></table>
  </div>
  <a href="/docs/xg12-manual.pdf">选型手册</a>
  <a href="/products/xg-24.html" rel="nofollow">XG-24</a>
</div>
<div class="footer">示例电气 版权所有</div>
</body></html>`;

describe("parsing with a versioned profile", () => {
	it("extracts fields with locators from a product page", () => {
		const outcome = parseSitePage(productPage(10), `${BASE}/products/xg-12.html`, profile);
		expect(outcome.status).toBe("PARSED");
		const page = outcome.page;
		if (!page) throw new Error("no page");
		expect(page.category).toBe("product");
		expect(page.entityKind).toBe("PRODUCT");
		expect(page.title).toBe("XG-12 铠装移开式高压开关柜");
		expect(page.parserVersion).toBe("core-1/example-electric@3");
		const field = (path: string) => page.fields.find((entry) => entry.path === path);
		expect(field("model")?.value).toBe("XG-12");
		expect(field("model")?.locator).toMatchObject({ selector: ".product-name", ordinal: 0 });
		expect(field("summary")?.value).toBe("适用于三相交流 50Hz 电网。\n用于接受和分配电能。");
		expect(field("images")?.value).toEqual([`${BASE}/upload/xg12-front.jpg`, `${BASE}/upload/xg12-side.jpg`]);
		expect(field("parameters")?.value).toEqual([
			["项目", "参数"],
			["额定电流", "1250A"],
		]);
		expect(page.text).not.toContain("版权所有");
		expect(page.text).not.toContain("window.token");
	});

	it("fails a page whose required field is missing instead of guessing", () => {
		const html = productPage(1).replace("XG-12 铠装", "铠装");
		const outcome = parseSitePage(html, `${BASE}/products/xg-12.html`, profile);
		expect(outcome).toMatchObject({ status: "FAILED", errorCode: "REQUIRED_FIELD_MISSING" });
	});

	it("reads a case date in any common Chinese format", () => {
		const html = `<html><body><div class="main"><div class="case-title">某园区配电工程</div>
			<div class="case-meta">发布时间：2025-7-5 浏览次数：88次</div><div class="case-body"><p>项目概况</p></div></div></body></html>`;
		const outcome = parseSitePage(html, `${BASE}/cases/41.html`, profile);
		expect(outcome.page?.category).toBe("case");
		expect(outcome.page?.publishedAt).toBe("2025-07-05");
	});

	it("leaves pages outside every category uncategorized and unmapped", () => {
		const outcome = parseSitePage("<html><body><h1>招聘</h1></body></html>", `${BASE}/jobs.html`, profile);
		expect(outcome.page?.category).toBeNull();
		expect(siteContentNormalizer.normalize(outcome.page as never)).toEqual([]);
	});
});

describe("entities and claims", () => {
	it("turns a product page into one entity whose specification claims are high risk", () => {
		const outcome = parseSitePage(productPage(10), `${BASE}/products/xg-12.html`, profile);
		const [entity] = siteContentNormalizer.normalize(outcome.page as never);
		expect(entity).toMatchObject({ kind: "PRODUCT", canonicalKey: "xg12", title: "XG-12" });
		const claims = siteKnowledgeMapper.map(entity, profile);
		const byPath = Object.fromEntries(claims.map((claim) => [claim.fieldPath, claim]));
		expect(byPath.ratedVoltage).toMatchObject({ riskLevel: "HIGH", normalizedValue: "12kV" });
		expect(byPath.model.riskLevel).toBe("NORMAL");
		expect(byPath.summary.riskLevel).toBe("HIGH");
		expect(byPath.images).toBeUndefined();
	});
});

describe("version identity", () => {
	const url = `${BASE}/products/xg-12.html`;

	it("ignores scripts and the volatile counter when hashing", () => {
		expect(contentHashOf(productPage(10), profile)).toBe(contentHashOf(productPage(9999), profile));
	});

	it("changes when the content does", () => {
		expect(contentHashOf(productPage(10), profile)).not.toBe(contentHashOf(productPage(10, "24kV"), profile));
	});

	it("records no new version for unchanged content and none for a duplicate URL", () => {
		const hash = contentHashOf(productPage(10), profile);
		const fetched = { contentHash: hash, hasVersionWithContent: false, otherPageHasContent: false };
		expect(decideVersion({ ...fetched, currentHashOfPage: hash })).toBe("UNCHANGED");
		expect(decideVersion({ ...fetched, currentHashOfPage: null, otherPageHasContent: true })).toBe("DUPLICATE");
		expect(decideVersion({ ...fetched, currentHashOfPage: "old" })).toBe("NEW_VERSION");
	});

	it("gives a profile upgrade a new parser version for the same content", () => {
		const upgraded = parseSiteProfile({ ...profileInput, version: 4 });
		expect(parserVersionOf(upgraded)).not.toBe(parserVersionOf(profile));
		expect(contentHashOf(productPage(10), upgraded)).toBe(contentHashOf(productPage(10), profile));
		expect(parseSitePage(productPage(10), url, upgraded).page?.parserVersion).toBe("core-1/example-electric@4");
	});
});

describe("discovery", () => {
	it("classifies links and keeps nofollow visible", () => {
		const listing = `<html><head><link rel="canonical" href="/cases.html"></head><body>
			<a href="/cases/41.html">案例</a><div class="page_list"><a href="/cases_p2.html">2</a><a href="/cases_p2.html">下一页</a></div>
			<a href="javascript:void(0)">x</a><a href="mailto:a@example-electric.test">邮件</a></body></html>`;
		const discovery = siteDiscovery.discover(listing, `${BASE}/cases_p1.html`, profile);
		expect(discovery.canonical).toBe(`${BASE}/cases.html`);
		expect(discovery.links.map((link) => [link.url, link.kind])).toEqual([
			[`${BASE}/cases/41.html`, "PAGE"],
			[`${BASE}/cases_p2.html`, "PAGINATION"],
		]);
		const product = siteDiscovery.discover(productPage(1), `${BASE}/products/xg-12.html`, profile);
		expect(product.links.find((link) => link.url.endsWith(".pdf"))?.kind).toBe("ASSET");
		expect(product.links.find((link) => link.url.endsWith("xg-24.html"))?.nofollow).toBe(true);
	});

	it("reads sitemap files and sitemap indexes", () => {
		const index = siteDiscovery.sitemapUrls(
			`<?xml version="1.0"?><sitemapindex><sitemap><loc>${BASE}/sitemap-1.xml</loc></sitemap></sitemapindex>`,
			`${BASE}/sitemap.xml`,
		);
		expect(index.sitemaps).toEqual([`${BASE}/sitemap-1.xml`]);
		const urls = siteDiscovery.sitemapUrls(
			`<urlset><url><loc>${BASE}/products/xg-12.html</loc></url></urlset>`,
			`${BASE}/sitemap-1.xml`,
		);
		expect(urls.pages).toEqual([`${BASE}/products/xg-12.html`]);
	});
});

describe("snapshot viewing", () => {
	it("strips everything that could run or call out from a stored page", () => {
		const hostile = `<html><head><base href="http://attacker.test/"><meta http-equiv="refresh" content="0;url=http://attacker.test">
			<link rel="stylesheet" href="http://attacker.test/x.css"><style>@import url(http://attacker.test/a.css); body{background:url(http://attacker.test/b.png)}</style></head>
			<body onload="alert(1)"><script>alert(1)</script><img src="x" onerror="alert(2)" alt="产品图">
			<a href="javascript:alert(3)">x</a><a href="/products/xg-12.html">产品</a>
			<iframe src="http://attacker.test"></iframe><form action="http://attacker.test"><input name="q"></form>
			<svg><script>alert(4)</script></svg><div style="background:url(javascript:alert(5))">正文</div></body></html>`;
		const safe = renderSnapshotForViewing(hostile);
		expect(safe).not.toMatch(
			/<script|onerror|onload|javascript:|<iframe|<form|<base|attacker\.test|http-equiv="refresh"/i,
		);
		expect(safe).toContain("Content-Security-Policy");
		expect(safe).toContain("[产品图]");
		expect(safe).toContain('data-original-href="/products/xg-12.html"');
		expect(safe).toContain("正文");
	});
});
