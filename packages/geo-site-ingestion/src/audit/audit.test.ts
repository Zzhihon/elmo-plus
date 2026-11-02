import { describe, expect, it } from "vitest";
import type { SafeFetchResult } from "../net/safe-fetch";
import { parseSitePage } from "../parser";
import { parseSiteProfile } from "../profile";
import { resolveAuditConfig, type SiteAuditConfigInput } from "./config";
import { type AuditPageFacts, extractAuditFacts } from "./facts";
import { recommendTargetPrompts } from "./recommend";
import { type ExistingFinding, reconcileFindings } from "./reconcile";
import { type AuditDetection, evaluatePageRules, type KnownPage } from "./rules";
import { classifyHttpsProbe, evaluateSiteChecks, type SiteProbes } from "./site-checks";

const ORIGIN = "https://www.example-electric.test";
const HOSTS = ["www.example-electric.test"];

const profile = parseSiteProfile({
	id: "example",
	version: 1,
	categories: [
		{
			key: "product",
			label: "产品中心",
			urlPatterns: ["^/product/"],
			entityKind: "PRODUCT",
			content: [".content"],
			fields: [{ path: "model", selector: [".model"] }],
		},
		{ key: "case", label: "工程案例", urlPatterns: ["^/case/"], entityKind: "CASE", content: [".content"] },
		{ key: "faq", label: "常见问题", urlPatterns: ["^/faq"], role: "section", content: [".content"] },
	],
});

const LONG_TEXT =
	"示例电气生产的高低压开关柜面向配电工程，柜体采用模块化结构，便于安装与维护。".repeat(6) +
	"产品出厂前逐台进行检验，并提供安装指导与售后服务。";

interface PageSpec {
	path: string;
	title?: string | null;
	description?: string | null;
	h1?: string[];
	canonical?: string[];
	body?: string;
	head?: string;
	links?: string[];
}

function html(spec: PageSpec): string {
	const title = spec.title === null ? "" : `<title>${spec.title ?? `页面 ${spec.path}`}</title>`;
	const description =
		spec.description === null
			? ""
			: `<meta name="description" content="${spec.description ?? `关于 ${spec.path} 的说明文字，介绍页面的主要内容。`}">`;
	const canonical = (spec.canonical ?? [`${ORIGIN}${spec.path}`])
		.map((href) => `<link rel="canonical" href="${href}">`)
		.join("");
	const h1 = (spec.h1 ?? [`标题 ${spec.path}`]).map((text) => `<h1>${text}</h1>`).join("");
	const links = (spec.links ?? []).map((href) => `<a href="${href}">链接</a>`).join("");
	return `<!doctype html><html lang="zh-CN"><head>${title}${description}${canonical}${spec.head ?? ""}</head>
<body><nav><a href="/">首页</a>${links}</nav>${h1}<div class="content">${spec.body ?? `<p>${LONG_TEXT}</p>`}</div><footer>版权所有</footer></body></html>`;
}

function facts(spec: PageSpec, id = spec.path): AuditPageFacts {
	const url = `${ORIGIN}${spec.path}`;
	const source = html(spec);
	const outcome = parseSitePage(source, url, profile);
	return extractAuditFacts({
		pageId: id,
		versionId: `v-${id}`,
		url,
		html: source,
		parsed: outcome.page,
		allowedHosts: HOSTS,
		isHome: spec.path === "/",
		keySection: false,
	});
}

function known(path: string, status: KnownPage["status"], extra: Partial<KnownPage> = {}): [string, KnownPage] {
	const url = `${ORIGIN}${path}`;
	return [url, { pageId: path, url, status, httpStatus: status === "GONE" ? 404 : 200, canonicalUrl: null, ...extra }];
}

function run(
	pages: AuditPageFacts[],
	options: { known?: Array<[string, KnownPage]>; config?: SiteAuditConfigInput } = {},
) {
	const knownPages = new Map<string, KnownPage>([
		...pages.map((page) => known(new URL(page.url).pathname, "ACTIVE", { pageId: page.pageId })),
		...(options.known ?? []),
	]);
	return evaluatePageRules(pages, {
		config: resolveAuditConfig(options.config),
		allowedHosts: HOSTS,
		knownPages,
		caseCategories: new Set(["case"]),
		pageCategories: new Map(
			[...knownPages.values()].map((page) => [page.pageId, page.url.includes("/case/") ? "case" : null]),
		),
	});
}

function rulesOn(detections: AuditDetection[], pageId: string): string[] {
	return detections.filter((detection) => detection.pageId === pageId).map((detection) => detection.ruleId);
}

describe("page metadata rules", () => {
	it("reports a missing title and a title too long for result snippets", () => {
		const missing = facts({ path: "/a.html", title: null });
		const long = facts({ path: "/b.html", title: "高低压开关柜".repeat(8) });
		const fine = facts({ path: "/c.html", title: "开关柜产品介绍" });
		const { detections } = run([missing, long, fine]);
		expect(rulesOn(detections, "/a.html")).toContain("title.missing");
		expect(rulesOn(detections, "/b.html")).toContain("title.too_long");
		expect(rulesOn(detections, "/c.html")).not.toContain("title.too_long");
		expect(rulesOn(detections, "/c.html")).not.toContain("title.missing");
	});

	it("reports titles and descriptions shared between pages, not unique ones", () => {
		const one = facts({ path: "/a.html", title: "示例电气", description: "示例电气官网" });
		const two = facts({ path: "/b.html", title: "示例电气 ", description: "示例电气官网" });
		const three = facts({ path: "/c.html", title: "开关柜", description: "开关柜产品的用途与特点。" });
		const { detections } = run([one, two, three]);
		expect(rulesOn(detections, "/a.html")).toEqual(
			expect.arrayContaining(["title.duplicate", "description.duplicate"]),
		);
		expect(rulesOn(detections, "/b.html")).toEqual(
			expect.arrayContaining(["title.duplicate", "description.duplicate"]),
		);
		expect(rulesOn(detections, "/c.html")).not.toContain("title.duplicate");
		expect(rulesOn(detections, "/c.html")).not.toContain("description.duplicate");
	});

	it("reports a missing description and one that repeats the title", () => {
		const missing = facts({ path: "/a.html", description: null });
		const same = facts({ path: "/b.html", title: "开关柜 - 示例电气", description: "开关柜-示例电气" });
		const distinct = facts({
			path: "/c.html",
			title: "开关柜",
			description: "适用于配电工程的开关柜，介绍用途与选型要点。",
		});
		const { detections } = run([missing, same, distinct]);
		expect(rulesOn(detections, "/a.html")).toContain("description.missing");
		expect(rulesOn(detections, "/b.html")).toContain("description.same_as_title");
		expect(rulesOn(detections, "/c.html")).not.toContain("description.same_as_title");
	});

	it("reports no H1 and more than one H1", () => {
		const { detections } = run([
			facts({ path: "/a.html", h1: [] }),
			facts({ path: "/b.html", h1: ["一", "二"] }),
			facts({ path: "/c.html", h1: ["一"] }),
		]);
		expect(rulesOn(detections, "/a.html")).toContain("h1.missing");
		expect(rulesOn(detections, "/b.html")).toContain("h1.multiple");
		expect(rulesOn(detections, "/c.html").filter((id) => id.startsWith("h1."))).toEqual([]);
	});

	it("reports images without alt only above the configured share", () => {
		const images = (alts: Array<string | null>) =>
			`<p>${LONG_TEXT}</p>${alts.map((alt, i) => `<img src="/img/${i}.jpg"${alt ? ` alt="${alt}"` : ""}>`).join("")}`;
		const { detections } = run([
			facts({ path: "/a.html", body: images([null, null, "柜体外观"]) }),
			facts({ path: "/b.html", body: images([null, "柜体外观", "铭牌"]) }),
		]);
		expect(rulesOn(detections, "/a.html")).toContain("image.alt_missing");
		expect(rulesOn(detections, "/b.html")).not.toContain("image.alt_missing");
	});
});

describe("link and canonical rules", () => {
	it("reports links to gone and redirected pages from what the crawl recorded", () => {
		const page = facts({ path: "/a.html", links: ["/old.html", "/moved.html", "/b.html"] });
		const target = facts({ path: "/b.html" });
		const { detections } = run([page, target], {
			known: [known("/old.html", "GONE"), known("/moved.html", "REDIRECTED", { canonicalUrl: `${ORIGIN}/new.html` })],
		});
		const broken = detections.find((d) => d.pageId === "/a.html" && d.ruleId === "link.broken_internal");
		expect(broken?.evidence.links).toEqual([{ url: `${ORIGIN}/old.html`, httpStatus: 404 }]);
		expect(rulesOn(detections, "/a.html")).toContain("link.redirected_internal");
		expect(rulesOn(detections, "/b.html")).not.toContain("link.broken_internal");
	});

	it("reports a missing canonical and ones pointing off site or at the home page", () => {
		const { detections } = run([
			facts({ path: "/a.html", canonical: [] }),
			facts({ path: "/b.html", canonical: ["https://other.test/b.html"] }),
			facts({
				path: "/product/c.html",
				canonical: [`${ORIGIN}/`],
				body: `<p class="model">X-1</p><p>${LONG_TEXT}</p>`,
			}),
			facts({ path: "/d.html" }),
		]);
		expect(rulesOn(detections, "/a.html")).toContain("canonical.missing");
		expect(rulesOn(detections, "/b.html")).toContain("canonical.abnormal");
		expect(rulesOn(detections, "/product/c.html")).toContain("canonical.abnormal");
		expect(rulesOn(detections, "/d.html").filter((id) => id.startsWith("canonical."))).toEqual([]);
	});
});

describe("structured data rules", () => {
	const ld = (value: unknown) => `<script type="application/ld+json">${JSON.stringify(value)}</script>`;

	it("wants Organization on the home page, found inside @graph too", () => {
		const bare = run([facts({ path: "/" })]);
		expect(rulesOn(bare.detections, "/")).toContain("structured_data.organization_missing");
		const withGraph = run([
			facts({ path: "/", head: ld({ "@context": "https://schema.org", "@graph": [{ "@type": "Organization" }] }) }),
		]);
		expect(rulesOn(withGraph.detections, "/")).not.toContain("structured_data.organization_missing");
	});

	it("wants Product and BreadcrumbList on product pages and reports broken JSON-LD", () => {
		const body = `<p class="model">X-1</p><p>${LONG_TEXT}</p>`;
		const without = facts({
			path: "/product/a.html",
			body,
			head: '<script type="application/ld+json">{"@type": </script>',
		});
		const withData = facts({
			path: "/product/b.html",
			body,
			head: ld([{ "@type": "Product", name: "X-1" }, { "@type": "BreadcrumbList" }]),
		});
		const { detections } = run([without, withData]);
		expect(rulesOn(detections, "/product/a.html")).toEqual(
			expect.arrayContaining([
				"structured_data.invalid",
				"structured_data.product_missing",
				"structured_data.breadcrumb_missing",
			]),
		);
		expect(rulesOn(detections, "/product/b.html").filter((id) => id.startsWith("structured_data."))).toEqual([]);
	});
});

describe("content rules", () => {
	it("reports placeholder copy under a heading", () => {
		const { detections } = run([
			facts({ path: "/about/idea.html", body: "<h2>服务理念</h2><p>ssas</p>" }),
			facts({ path: "/about/real.html" }),
		]);
		expect(rulesOn(detections, "/about/idea.html")).toEqual(["content.placeholder"]);
		expect(rulesOn(detections, "/about/real.html").filter((id) => id.startsWith("content."))).toEqual([]);
	});

	it("reports an empty FAQ section and raises it as an FAQ task", () => {
		const { detections } = run([
			facts({ path: "/faq.html", body: "<p>暂无相关数据</p>" }),
			facts({ path: "/faq2.html", body: "<dl><dt>开关柜如何选型？</dt><dd>按额定电压与负荷选择。</dd></dl>" }),
		]);
		const empty = detections.find((d) => d.pageId === "/faq.html" && d.ruleId === "section.empty");
		expect(empty?.taskKind).toBe("FAQ");
		expect(rulesOn(detections, "/faq2.html")).not.toContain("section.empty");
	});

	it("reports an image-only case page as a case task, and short text elsewhere", () => {
		const imageOnly = facts({
			path: "/case/1.html",
			body: '<img src="/img/case-1.jpg" alt="现场"><img src="/img/case-2.jpg" alt="柜体">',
		});
		const withText = facts({ path: "/case/2.html", body: `<img src="/img/case-3.jpg" alt="现场"><p>${LONG_TEXT}</p>` });
		const short = facts({ path: "/news/1.html", body: "<p>公司参加行业展会。</p>" });
		const { detections } = run([imageOnly, withText, short]);
		const finding = detections.find((d) => d.pageId === "/case/1.html" && d.ruleId === "content.image_only");
		expect(finding?.taskKind).toBe("CASE_ADDITION");
		expect(rulesOn(detections, "/case/2.html").filter((id) => id.startsWith("content."))).toEqual([]);
		expect(rulesOn(detections, "/news/1.html")).toContain("content.too_short");
	});
});

describe("product completeness rules", () => {
	const productIds = [
		"product.industries_missing",
		"product.selection_missing",
		"product.param_source_missing",
		"product.case_refs_missing",
	];

	it("reports each missing part of a product description", () => {
		const page = facts({ path: "/product/a.html", body: `<p class="model">X-1</p><p>${LONG_TEXT}</p>` });
		const { detections } = run([page]);
		expect(rulesOn(detections, "/product/a.html")).toEqual(expect.arrayContaining(productIds));
	});

	it("accepts keywords, a link to a case page, or a configured field", () => {
		const page = facts({
			path: "/product/b.html",
			links: ["/case/9.html"],
			body: `<p class="model">X-2</p><p>${LONG_TEXT}</p><h3>应用领域</h3><p>变电站、工业厂房。</p><h3>选型要点</h3><p>按额定电流选择。</p>`,
		});
		const { detections } = run([page], {
			known: [known("/case/9.html", "ACTIVE", { pageId: "/case/9.html" })],
			config: { productChecks: { paramSource: { keywords: ["参数依据"], fieldPaths: ["model"] } } },
		});
		expect(rulesOn(detections, "/product/b.html").filter((id) => id.startsWith("product."))).toEqual([]);
	});

	it("does not apply to pages that are not product details", () => {
		const { detections } = run([facts({ path: "/news/2.html" })]);
		expect(rulesOn(detections, "/news/2.html").filter((id) => id.startsWith("product."))).toEqual([]);
	});

	it("skips rules the profile disables", () => {
		const page = facts({ path: "/a.html", h1: [] });
		const { detections, evaluatedRuleIds } = run([page], { config: { disabledRules: ["h1.missing"] } });
		expect(rulesOn(detections, "/a.html")).not.toContain("h1.missing");
		expect(evaluatedRuleIds).not.toContain("h1.missing");
	});
});

function fetchError(code: "TIMEOUT" | "NETWORK", detail: string): SafeFetchResult {
	return { ok: false, code, detail, url: `${ORIGIN}/`, finalUrl: `${ORIGIN}/`, redirects: [], durationMs: 20_000 };
}

function fetchOk(finalUrl: string, status = 200): SafeFetchResult {
	return {
		ok: true,
		url: `${ORIGIN}/`,
		finalUrl,
		status,
		headers: {},
		mimeType: "text/html",
		charset: "utf-8",
		body: new Uint8Array(),
		redirects: [],
		durationMs: 50,
		address: "203.0.113.10",
	};
}

describe("site checks", () => {
	const base: SiteProbes = {
		baseUrl: "http://www.example-electric.test/",
		robots: {
			kind: "FILE",
			url: `${ORIGIN}/robots.txt`,
			status: 200,
			text: "User-agent: *\nDisallow: /admin\nSitemap: https://www.example-electric.test/sitemap.xml",
		},
		sitemap: {
			kind: "CHECKED",
			files: [
				{
					url: `${ORIGIN}/sitemap.xml`,
					declared: true,
					status: 200,
					error: null,
					valid: true,
					pages: [`${ORIGIN}/a.html`, `${ORIGIN}/b.html`],
					nested: [],
				},
			],
		},
		https: { kind: "OK", url: `${ORIGIN}/`, finalUrl: `${ORIGIN}/`, status: 200 },
	};
	const check = (
		probes: Partial<SiteProbes>,
		knownPages: Array<[string, KnownPage]> = [],
		indexable = [`${ORIGIN}/a.html`],
	) =>
		evaluateSiteChecks(
			{ ...base, ...probes },
			{
				config: resolveAuditConfig({}),
				allowedHosts: HOSTS,
				knownPages: new Map(knownPages),
				indexableUrls: indexable,
			},
		);
	const ids = (result: ReturnType<typeof check>) => result.detections.map((detection) => detection.ruleId);

	it("passes a healthy site except for the HTTP base address", () => {
		expect(ids(check({}))).toEqual(["https.not_enforced"]);
		expect(ids(check({ baseUrl: `${ORIGIN}/` }))).toEqual([]);
	});

	it("tells a missing robots.txt from an unreachable one and from one that blocks", () => {
		expect(
			ids(check({ robots: { kind: "NOT_FOUND", url: `${ORIGIN}/robots.txt`, status: 404, detail: null } })),
		).toContain("robots.missing");
		expect(
			ids(check({ robots: { kind: "UNAVAILABLE", url: `${ORIGIN}/robots.txt`, status: 503, detail: "HTTP 503" } })),
		).toContain("robots.unreachable");
		const blocking = check({
			robots: { kind: "FILE", url: `${ORIGIN}/robots.txt`, status: 200, text: "User-agent: *\nDisallow: /" },
		});
		expect(ids(blocking)).toEqual(expect.arrayContaining(["robots.blocks_site", "robots.sitemap_undeclared"]));
		const aiOnly = check({
			robots: {
				kind: "FILE",
				url: `${ORIGIN}/robots.txt`,
				status: 200,
				text: "User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nAllow: /\nSitemap: https://www.example-electric.test/sitemap.xml",
			},
		});
		const finding = aiOnly.detections.find((detection) => detection.ruleId === "robots.blocks_ai_crawlers");
		expect(finding?.evidence.crawlers).toEqual(["GPTBot"]);
		expect(ids(aiOnly)).not.toContain("robots.blocks_site");
	});

	it("reports a missing sitemap, an invalid one, stale entries and pages left out", () => {
		const file = base.sitemap.kind === "CHECKED" ? base.sitemap.files[0] : null;
		if (!file) throw new Error("fixture");
		expect(
			ids(check({ sitemap: { kind: "CHECKED", files: [{ ...file, status: 404, valid: false, pages: [] }] } })),
		).toContain("sitemap.missing");
		expect(
			ids(
				check({
					sitemap: { kind: "CHECKED", files: [{ ...file, valid: false, error: "根元素不是 urlset", pages: [] }] },
				}),
			),
		).toContain("sitemap.invalid");
		expect(ids(check({}, [known("/b.html", "GONE")]))).toContain("sitemap.stale_urls");
		const pages = ["/a.html", "/c.html", "/d.html", "/e.html"].map((path) => `${ORIGIN}${path}`);
		expect(ids(check({}, [], pages))).toContain("sitemap.incomplete");
	});

	it("records an HTTPS timeout and a certificate failure as different findings", () => {
		const timeout = classifyHttpsProbe(`${ORIGIN}/`, fetchError("TIMEOUT", "超过 20000 毫秒未完成"));
		const certificate = classifyHttpsProbe(`${ORIGIN}/`, fetchError("NETWORK", "certificate has expired"));
		const refused = classifyHttpsProbe(`${ORIGIN}/`, fetchError("NETWORK", "connect ECONNREFUSED 203.0.113.10:443"));
		const downgrade = classifyHttpsProbe(`${ORIGIN}/`, fetchOk("http://www.example-electric.test/"));
		expect(ids(check({ https: timeout }))).toContain("https.timeout");
		expect(ids(check({ https: certificate }))).toContain("https.certificate");
		expect(ids(check({ https: refused }))).toContain("https.unreachable");
		expect(ids(check({ https: downgrade }))).toContain("https.downgrade");
	});

	it("evaluates nothing it could not probe", () => {
		const skipped = check({
			robots: { kind: "SKIPPED", reason: "熔断" },
			sitemap: { kind: "SKIPPED", reason: "熔断" },
			https: { kind: "SKIPPED", reason: "熔断" },
		});
		expect(skipped.detections).toEqual([]);
		expect(skipped.evaluatedRuleIds).toEqual([]);
	});
});

describe("finding reconciliation across runs", () => {
	const detection = (ruleId: string, pageId: string | null): AuditDetection => ({
		ruleId,
		pageId,
		versionId: pageId ? `v-${pageId}` : null,
		evidence: { summary: "" },
	});
	const finding = (
		id: string,
		ruleId: string,
		pageId: string | null,
		status: ExistingFinding["status"],
		taskOpen = false,
	) => ({
		id,
		ruleId,
		pageId,
		status,
		taskOpen,
	});
	const scope = {
		pageRuleIds: ["h1.missing", "title.missing"],
		auditedPageIds: new Set(["p1", "p2"]),
		siteRuleIds: ["sitemap.missing"],
		unavailablePageIds: new Set(["gone"]),
	};

	it("keeps one finding per rule and page however often it is seen", () => {
		const first = reconcileFindings([], [detection("h1.missing", "p1"), detection("h1.missing", "p1")], scope);
		expect(first).toHaveLength(1);
		expect(first[0].kind).toBe("INSERT");
		const second = reconcileFindings(
			[finding("f1", "h1.missing", "p1", "OPEN")],
			[detection("h1.missing", "p1")],
			scope,
		);
		expect(second).toEqual([
			expect.objectContaining({ kind: "REFRESH", findingId: "f1", status: "OPEN", reopened: false }),
		]);
	});

	it("resolves what a rerun no longer finds, only where the rule looked", () => {
		const actions = reconcileFindings(
			[
				finding("fixed", "h1.missing", "p1", "OPEN"),
				finding("tasked", "title.missing", "p2", "TASKED", true),
				finding("unaudited", "h1.missing", "p9", "OPEN"),
				finding("other-rule", "canonical.missing", "p1", "OPEN"),
				finding("site", "sitemap.missing", null, "OPEN"),
				finding("site-skipped", "https.timeout", null, "OPEN"),
				finding("page-gone", "h1.missing", "gone", "OPEN"),
				finding("dismissed", "h1.missing", "p2", "DISMISSED"),
			],
			[],
			scope,
		);
		const resolved = actions.filter((action) => action.kind === "RESOLVE").map((action) => action.findingId);
		expect(resolved.sort()).toEqual(["fixed", "page-gone", "site", "tasked"]);
	});

	it("reopens a resolved finding that comes back, to its task if that is still open", () => {
		const reopened = reconcileFindings(
			[finding("f1", "h1.missing", "p1", "RESOLVED")],
			[detection("h1.missing", "p1")],
			scope,
		);
		expect(reopened[0]).toMatchObject({ kind: "REFRESH", status: "OPEN", reopened: true });
		const toTask = reconcileFindings(
			[finding("f2", "h1.missing", "p1", "RESOLVED", true)],
			[detection("h1.missing", "p1")],
			scope,
		);
		expect(toTask[0]).toMatchObject({ status: "TASKED", reopened: true });
	});

	it("leaves a dismissed finding dismissed and returns a finding whose task ended to open", () => {
		const actions = reconcileFindings(
			[finding("d", "h1.missing", "p1", "DISMISSED"), finding("t", "title.missing", "p1", "TASKED", false)],
			[detection("h1.missing", "p1"), detection("title.missing", "p1")],
			scope,
		);
		expect(actions).toEqual([
			expect.objectContaining({ findingId: "d", status: "DISMISSED" }),
			expect.objectContaining({ findingId: "t", status: "OPEN" }),
		]);
	});
});

describe("target question suggestions", () => {
	it("matches by product line and model, and ignores unrelated questions", () => {
		const prompts = [
			{ id: "line", question: "配电工程用哪家的开关柜比较可靠？", productLine: "开关柜", status: "BASELINE" as const },
			{ id: "model", question: "X-1 型号的柜体适合户外吗？", productLine: null, status: "DRAFT" as const },
			{ id: "other", question: "变压器的能效等级怎么看？", productLine: "变压器", status: "BASELINE" as const },
			{ id: "rejected", question: "开关柜价格", productLine: "开关柜", status: "REJECTED" as const },
		];
		const ids = recommendTargetPrompts({ title: "X-1 高压开关柜", categoryLabel: "产品中心", terms: ["X-1"] }, prompts);
		expect(ids.sort()).toEqual(["line", "model"]);
		expect(recommendTargetPrompts(null, prompts)).toEqual([]);
	});
});
