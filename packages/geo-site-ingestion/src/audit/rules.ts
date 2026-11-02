import type { GeoSitePageStatus, GeoTaskKind } from "@workspace/geo-domain";
import { isAllowedHost } from "../net/url-policy";
import { SITE_AUDIT_RULES } from "./catalog";
import { PRODUCT_CHECKS, type ProductCheck, type ResolvedAuditConfig } from "./config";
import type { AuditPageFacts } from "./facts";

/** One rule firing on one subject. `pageId` null means the whole site. */
export interface AuditDetection {
	ruleId: string;
	pageId: string | null;
	versionId: string | null;
	/** `summary` is a one-line description of what was seen, in Chinese, for the list view. */
	evidence: { summary: string } & Record<string, unknown>;
	taskKind?: GeoTaskKind;
}

/** What the crawl knows about a URL of the site, the basis for link and canonical checks. */
export interface KnownPage {
	pageId: string;
	url: string;
	status: GeoSitePageStatus;
	httpStatus: number | null;
	canonicalUrl: string | null;
}

export interface PageRuleContext {
	config: ResolvedAuditConfig;
	allowedHosts: readonly string[];
	knownPages: ReadonlyMap<string, KnownPage>;
	/** Profile categories whose pages are cases, so a link to one counts as a case reference. */
	caseCategories: ReadonlySet<string>;
	pageCategories: ReadonlyMap<string, string | null>;
}

export interface PageRuleResult {
	detections: AuditDetection[];
	/** Rules that looked at every page passed in; a finding of one of these not seen again is fixed. */
	evaluatedRuleIds: string[];
}

const SAMPLE = 10;

export function displayWidth(value: string): number {
	let width = 0;
	for (const char of value) width += /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-鿿가-힣豈-﫿︰-﹏＀-｠￠-￦]/u.test(char) ? 2 : 1;
	return width;
}

/** Comparable form of short copy: case, spacing and punctuation do not make two titles different. */
export function comparable(value: string): string {
	return value.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

function contentLength(value: string): number {
	return value.replace(/\s+/g, "").length;
}

/** Body lines that are not just the page's own headings, so a heading over an empty body still reads as empty. */
function bodyText(page: AuditPageFacts): string {
	const headings = new Set(
		[page.htmlTitle, ...page.h1s, ...page.headings, page.categoryLabel]
			.filter((value): value is string => Boolean(value))
			.map(comparable),
	);
	return page.text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line && !headings.has(comparable(line)))
		.join("\n");
}

function sameCopy(a: string, b: string): boolean {
	const left = comparable(a);
	const right = comparable(b);
	if (!left || !right) return false;
	if (left === right) return true;
	const [short, long] = left.length <= right.length ? [left, right] : [right, left];
	return long.includes(short) && short.length / long.length >= 0.8;
}

function duplicatesBy(
	pages: AuditPageFacts[],
	value: (page: AuditPageFacts) => string | null,
): Map<string, AuditPageFacts[]> {
	const groups = new Map<string, AuditPageFacts[]>();
	for (const page of pages) {
		const raw = value(page);
		const key = raw ? comparable(raw) : "";
		if (!key) continue;
		groups.set(key, [...(groups.get(key) ?? []), page]);
	}
	const byPage = new Map<string, AuditPageFacts[]>();
	for (const group of groups.values()) {
		if (group.length < 2) continue;
		for (const page of group) byPage.set(page.pageId, group);
	}
	return byPage;
}

function hasType(types: string[], accepted: (type: string) => boolean): boolean {
	return types.some(accepted);
}

const isOrganizationType = (type: string) =>
	/^(Organization|Corporation|LocalBusiness|OnlineBusiness|ProfessionalService|Store)$/i.test(type) ||
	/(Organization|Business)$/.test(type);
const isProductType = (type: string) =>
	/^(Product|ProductModel|IndividualProduct|ProductGroup|SomeProducts)$/i.test(type);
const isBreadcrumbType = (type: string) => /^BreadcrumbList$/i.test(type);

type Emit = (ruleId: string, evidence: AuditDetection["evidence"], taskKind?: GeoTaskKind) => void;

function metadataRules(page: AuditPageFacts, ctx: PageRuleContext, emit: Emit): void {
	if (page.noindex) emit("page.noindex", { summary: "meta robots 含 noindex" });
	if (!page.htmlTitle) emit("title.missing", { summary: "<title> 为空" });
	else {
		const width = displayWidth(page.htmlTitle);
		if (width > ctx.config.titleMaxWidth) {
			emit("title.too_long", {
				summary: `标题显示宽度 ${width}，超过 ${ctx.config.titleMaxWidth}`,
				title: page.htmlTitle,
				width,
				max: ctx.config.titleMaxWidth,
			});
		}
	}
	if (!page.metaDescription) emit("description.missing", { summary: "没有 meta description" });
	else if (page.htmlTitle && sameCopy(page.metaDescription, page.htmlTitle)) {
		emit("description.same_as_title", {
			summary: "description 与标题相同",
			title: page.htmlTitle,
			description: page.metaDescription,
		});
	}
	if (page.h1s.length === 0) emit("h1.missing", { summary: "页面没有 <h1>" });
	if (page.h1s.length > 1)
		emit("h1.multiple", { summary: `页面有 ${page.h1s.length} 个 <h1>`, h1s: page.h1s.slice(0, SAMPLE) });

	const images = page.images.filter((image) => image.src);
	const missing = images.filter((image) => !image.alt);
	if (missing.length > 0 && missing.length / images.length >= ctx.config.altMissingRatio) {
		emit("image.alt_missing", {
			summary: `正文 ${images.length} 张图片中 ${missing.length} 张缺少 alt`,
			total: images.length,
			missing: missing.length,
			samples: missing.slice(0, 5).map((image) => image.src),
		});
	}
}

function canonicalProblems(page: AuditPageFacts, ctx: PageRuleContext): string[] {
	const problems = page.invalidCanonicals.map((href) => `无效的 canonical：${href || "（空）"}`);
	if (page.canonicals.length > 1) problems.push(`声明了 ${page.canonicals.length} 个不同的 canonical`);
	for (const canonical of page.canonicals) {
		const target = new URL(canonical);
		if (!isAllowedHost(target.hostname, ctx.allowedHosts)) {
			problems.push(`指向其他域名：${canonical}`);
			continue;
		}
		if (canonical === page.url) continue;
		const known = ctx.knownPages.get(canonical);
		if (known?.status === "REDIRECTED") problems.push(`指向会重定向的网址：${canonical}`);
		else if (known && known.status !== "ACTIVE")
			problems.push(`指向不可访问的网址：${canonical}（HTTP ${known.httpStatus ?? "—"}）`);
		if (!page.isHome && page.role === "detail" && target.pathname === "/" && !target.search) {
			problems.push("详情页的 canonical 指向首页");
		}
	}
	return problems;
}

function linkRules(page: AuditPageFacts, ctx: PageRuleContext, emit: Emit): void {
	if (page.canonicals.length === 0 && page.invalidCanonicals.length === 0) {
		emit("canonical.missing", { summary: '没有 <link rel="canonical">' });
	} else {
		const problems = canonicalProblems(page, ctx);
		if (problems.length > 0) {
			emit("canonical.abnormal", { summary: problems[0], problems, canonicals: page.canonicals });
		}
	}

	const broken: Array<{ url: string; httpStatus: number | null }> = [];
	const redirected: Array<{ url: string; to: string | null }> = [];
	for (const link of page.internalLinks) {
		const known = ctx.knownPages.get(link);
		if (!known) continue;
		if (known.status === "GONE") broken.push({ url: link, httpStatus: known.httpStatus });
		else if (known.status === "REDIRECTED") redirected.push({ url: link, to: known.canonicalUrl });
	}
	if (broken.length > 0) {
		emit("link.broken_internal", {
			summary: `${broken.length} 个站内链接失效，如 ${broken[0].url}`,
			count: broken.length,
			links: broken.slice(0, 20),
		});
	}
	if (redirected.length > 0) {
		emit("link.redirected_internal", {
			summary: `${redirected.length} 个站内链接需要跳转，如 ${redirected[0].url}`,
			count: redirected.length,
			links: redirected.slice(0, 20),
		});
	}
}

function structuredDataRules(page: AuditPageFacts, emit: Emit): void {
	if (page.structuredDataErrors.length > 0) {
		emit("structured_data.invalid", { summary: page.structuredDataErrors[0], errors: page.structuredDataErrors });
	}
	const types = page.structuredTypes;
	if (page.isHome && !hasType(types, isOrganizationType)) {
		emit("structured_data.organization_missing", { summary: "首页没有 Organization 结构化数据", types });
	}
	if (page.entityKind === "PRODUCT" && page.role === "detail" && !hasType(types, isProductType)) {
		emit("structured_data.product_missing", { summary: "产品页没有 Product 结构化数据", types });
	}
	if (page.role === "detail" && !page.isHome && !hasType(types, isBreadcrumbType)) {
		emit("structured_data.breadcrumb_missing", { summary: "详情页没有 BreadcrumbList 结构化数据", types });
	}
}

function looksLikeFaq(page: AuditPageFacts): boolean {
	return /faq|问答|常见问题|答疑/i.test(`${page.category ?? ""} ${page.categoryLabel ?? ""} ${page.url}`);
}

/** At most one content finding per page: the most specific explanation of a thin page wins. */
function contentRules(page: AuditPageFacts, ctx: PageRuleContext, emit: Emit): void {
	const body = bodyText(page);
	const length = contentLength(body);
	const images = page.images.filter((image) => image.src).length;
	const excerpt = body.slice(0, 120);

	const emptyMarker = ctx.config.emptySectionPatterns.find((pattern) => pattern.test(body));
	if (emptyMarker && length < 60) {
		emit(
			"section.empty",
			{ summary: `页面内容只有“${excerpt}”`, excerpt, images },
			looksLikeFaq(page) ? "FAQ" : undefined,
		);
		return;
	}
	if (body && ctx.config.placeholderPatterns.some((pattern) => pattern.test(body))) {
		emit("content.placeholder", { summary: `正文为“${excerpt}”`, excerpt, textLength: length });
		return;
	}
	if (page.role === "detail" && images > 0 && length <= ctx.config.imageOnlyMaxText) {
		emit(
			"content.image_only",
			{ summary: `正文 ${length} 字、${images} 张图片`, textLength: length, images },
			page.entityKind === "CASE" ? "CASE_ADDITION" : undefined,
		);
		return;
	}
	if (page.role !== "listing" && length < ctx.config.minTextLength) {
		emit("content.too_short", {
			summary: `正文 ${length} 字，少于 ${ctx.config.minTextLength} 字`,
			textLength: length,
			min: ctx.config.minTextLength,
			excerpt,
		});
	}
}

const PRODUCT_CHECK_RULES: Record<ProductCheck, string> = {
	industries: "product.industries_missing",
	selection: "product.selection_missing",
	paramSource: "product.param_source_missing",
	caseRefs: "product.case_refs_missing",
};

const PRODUCT_CHECK_LABELS: Record<ProductCheck, string> = {
	industries: "应用行业",
	selection: "选型问题",
	paramSource: "参数来源",
	caseRefs: "案例引用",
};

function linksToCase(page: AuditPageFacts, ctx: PageRuleContext): boolean {
	return page.internalLinks.some((link) => {
		const known = ctx.knownPages.get(link);
		const category = known ? ctx.pageCategories.get(known.pageId) : null;
		return Boolean(category && ctx.caseCategories.has(category));
	});
}

function productRules(page: AuditPageFacts, ctx: PageRuleContext, emit: Emit): void {
	if (page.entityKind !== "PRODUCT" || page.role !== "detail") return;
	const text = page.text.toLowerCase();
	const filled = new Set(page.fields.map((field) => field.path));
	for (const check of PRODUCT_CHECKS) {
		const { keywords, fieldPaths } = ctx.config.productChecks[check];
		const satisfied =
			fieldPaths.some((path) => filled.has(path)) ||
			keywords.some((keyword) => text.includes(keyword.toLowerCase())) ||
			(check === "caseRefs" && linksToCase(page, ctx));
		if (satisfied) continue;
		emit(PRODUCT_CHECK_RULES[check], {
			summary: `正文和抽取字段中没有${PRODUCT_CHECK_LABELS[check]}相关内容`,
			keywords: keywords.slice(0, 12),
			fieldPaths,
		});
	}
}

/**
 * Runs every enabled page rule over the pages of one site. Rules that compare
 * pages (duplicate titles and descriptions) see the whole set at once.
 */
export function evaluatePageRules(pages: AuditPageFacts[], ctx: PageRuleContext): PageRuleResult {
	const enabled = SITE_AUDIT_RULES.filter((rule) => rule.scope === "PAGE" && !ctx.config.disabledRules.has(rule.id));
	const enabledIds = new Set(enabled.map((rule) => rule.id));
	const detections: AuditDetection[] = [];
	const duplicateTitles = duplicatesBy(pages, (page) => page.htmlTitle);
	const duplicateDescriptions = duplicatesBy(pages, (page) => page.metaDescription);

	for (const page of pages) {
		const emit: Emit = (ruleId, evidence, taskKind) => {
			if (!enabledIds.has(ruleId)) return;
			detections.push({ ruleId, pageId: page.pageId, versionId: page.versionId, evidence, taskKind });
		};
		metadataRules(page, ctx, emit);
		const sameTitle = duplicateTitles.get(page.pageId);
		if (sameTitle) {
			const others = sameTitle.filter((other) => other.pageId !== page.pageId);
			emit("title.duplicate", {
				summary: `与另外 ${others.length} 个页面标题相同`,
				title: page.htmlTitle,
				count: others.length,
				pages: others.slice(0, SAMPLE).map((other) => ({ pageId: other.pageId, url: other.url })),
			});
		}
		const sameDescription = duplicateDescriptions.get(page.pageId);
		if (sameDescription) {
			const others = sameDescription.filter((other) => other.pageId !== page.pageId);
			emit("description.duplicate", {
				summary: `与另外 ${others.length} 个页面 description 相同`,
				description: page.metaDescription,
				count: others.length,
				pages: others.slice(0, SAMPLE).map((other) => ({ pageId: other.pageId, url: other.url })),
			});
		}
		linkRules(page, ctx, emit);
		structuredDataRules(page, emit);
		contentRules(page, ctx, emit);
		productRules(page, ctx, emit);
	}
	return { detections, evaluatedRuleIds: [...enabledIds] };
}
