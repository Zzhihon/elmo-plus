import { GEO_SITE_ENTITY_KINDS } from "@workspace/geo-domain";
import { z } from "zod";
import { siteAuditConfigSchema } from "./audit/config";

/** Bumped whenever the generic parsing code changes what it extracts from the same HTML. */
export const CORE_PARSER_VERSION = "1";

function isValidRegex(pattern: string): boolean {
	try {
		new RegExp(pattern);
		return true;
	} catch {
		return false;
	}
}

const regex = z.string().min(1).max(500).refine(isValidRegex, "不是合法的正则表达式");
const selector = z.string().min(1).max(500);
const selectors = z.array(selector).max(20);

const fieldPath = z
	.string()
	.regex(/^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)*$/, "字段路径只能是点分隔的驼峰标识符")
	.max(120);

export const siteFieldTypeSchema = z.enum(["text", "multiline", "date", "image", "images", "list", "table", "link"]);
export type SiteFieldType = z.infer<typeof siteFieldTypeSchema>;

export const siteFieldRuleSchema = z.object({
	path: fieldPath,
	label: z.string().max(60).optional(),
	selector: selectors.min(1),
	type: siteFieldTypeSchema.default("text"),
	/** Read this attribute instead of the text, e.g. `src` or `content`. */
	attr: z.string().max(40).optional(),
	/** Keep only the first capture group (or the whole match) of this pattern. */
	pattern: regex.optional(),
	required: z.boolean().default(false),
	/** Overrides the core rules for whether a reviewer must hold the original document. */
	risk: z.enum(["HIGH", "NORMAL"]).optional(),
	/** The field becomes a knowledge assertion of this claim type. Omit to keep it as page data only. */
	claimType: z.string().max(60).optional(),
});
export type SiteFieldRule = z.infer<typeof siteFieldRuleSchema>;

export const siteCategorySchema = z.object({
	key: z
		.string()
		.regex(/^[a-z][a-z0-9-]*$/)
		.max(40),
	label: z.string().min(1).max(40),
	/** Path plus query, matched against the normalized URL. Any one matching is enough. */
	urlPatterns: z.array(regex).max(30).default([]),
	/** When present, the page must also contain one of these. */
	requireSelector: selectors.optional(),
	role: z.enum(["detail", "listing", "section"]).default("detail"),
	entityKind: z.enum(GEO_SITE_ENTITY_KINDS).optional(),
	/** Pages of this category are on the customer's checklist and count toward section coverage. */
	keySection: z.boolean().default(false),
	title: selectors.optional(),
	content: selectors.optional(),
	remove: selectors.optional(),
	fields: z.array(siteFieldRuleSchema).max(40).default([]),
});
export type SiteCategory = z.infer<typeof siteCategorySchema>;

export const siteProfileSchema = z.object({
	id: z
		.string()
		.regex(/^[a-z0-9][a-z0-9-]*$/)
		.max(60),
	version: z.number().int().min(1),
	description: z.string().max(500).optional(),
	scope: z
		.object({
			include: z.array(regex).max(50).default([]),
			exclude: z.array(regex).max(50).default([]),
			maxDepth: z.number().int().min(0).max(20).default(6),
			followLinks: z.boolean().default(true),
		})
		.default({ include: [], exclude: [], maxDepth: 6, followLinks: true }),
	respectNofollow: z.boolean().default(true),
	/** Parts of a page that change on every view (counters, tokens) and must not create a version. */
	volatile: z
		.object({ selectors: selectors.default([]), patterns: z.array(regex).max(20).default([]) })
		.default({ selectors: [], patterns: [] }),
	pagination: z.object({ patterns: z.array(regex).max(20).default([]) }).default({ patterns: [] }),
	defaults: z
		.object({
			title: selectors.default(["h1", "title"]),
			content: selectors.default(["main", "article", "body"]),
			remove: selectors.default(["header", "footer", "nav", "script", "style", "noscript", "form"]),
			publishedAt: z.object({ selector: selectors.min(1), pattern: regex.optional() }).optional(),
			/** Removed from every title, e.g. a site-name suffix repeated on each page. */
			titleStrip: z.array(regex).max(10).default([]),
		})
		.default({
			titleStrip: [],
			title: ["h1", "title"],
			content: ["main", "article", "body"],
			remove: ["header", "footer", "nav", "script", "style", "noscript", "form"],
		}),
	categories: z.array(siteCategorySchema).max(40).default([]),
	assets: z
		.object({
			extensions: z
				.array(z.string().regex(/^\.[a-z0-9]{1,8}$/))
				.max(30)
				.default([".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".zip", ".rar"]),
			download: z.boolean().default(false),
			maxCount: z.number().int().min(0).max(1000).default(50),
			mimeTypes: z
				.array(z.string().max(100))
				.max(30)
				.default([
					"application/pdf",
					"application/msword",
					"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
					"application/vnd.ms-excel",
					"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
				]),
		})
		.default({
			extensions: [".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".zip", ".rar"],
			download: false,
			maxCount: 50,
			mimeTypes: [
				"application/pdf",
				"application/msword",
				"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
				"application/vnd.ms-excel",
				"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
			],
		}),
	/** Field paths (with `*` for one segment) whose claims always need a reviewer holding the original. */
	highRiskFields: z.array(z.string().max(120)).max(50).default([]),
	/** Fields offered for labelling in a quality sample, beyond title, category and body. */
	qaFields: z.array(fieldPath).max(20).default([]),
	alerts: z
		.object({
			parseSuccessMin: z.number().min(0).max(1).default(0.9),
			sectionDropRatio: z.number().min(0).max(1).default(0.5),
			blockedResponseRatio: z.number().min(0).max(1).default(0.2),
			reviewSlaDays: z.number().int().min(1).max(90).default(5),
		})
		.default({ parseSuccessMin: 0.9, sectionDropRatio: 0.5, blockedResponseRatio: 0.2, reviewSlaDays: 5 }),
	/** Thresholds and keywords for the site audit; see `audit/config.ts`. */
	audit: siteAuditConfigSchema.optional(),
});
export type SiteProfile = z.infer<typeof siteProfileSchema>;
export type SiteProfileInput = z.input<typeof siteProfileSchema>;

export function parseSiteProfile(input: unknown): SiteProfile {
	return siteProfileSchema.parse(input);
}

export function safeParseSiteProfile(input: unknown) {
	return siteProfileSchema.safeParse(input);
}

/** The generic profile: no categories, so pages are kept and parsed but nothing is mapped to entities. */
export function defaultSiteProfile(): SiteProfile {
	return parseSiteProfile({ id: "generic", version: 1 });
}

/** Two versions of the same HTML parsed by different code or rules are different parse results. */
export function parserVersionOf(profile: Pick<SiteProfile, "id" | "version">): string {
	return `core-${CORE_PARSER_VERSION}/${profile.id}@${profile.version}`;
}

const opWindowSchema = z.object({
	timezone: z.string().max(60).default("Asia/Shanghai"),
	/** ISO weekdays, 1 = Monday. Empty means every day. */
	days: z.array(z.number().int().min(1).max(7)).max(7).default([]),
	start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
	end: z.string().regex(/^([01]\d|2[0-4]):[0-5]\d$/),
});
export type SiteOpWindow = z.infer<typeof opWindowSchema>;

export function parseOpWindow(input: unknown): SiteOpWindow | null {
	if (input === null || input === undefined) return null;
	const parsed = opWindowSchema.safeParse(input);
	return parsed.success ? parsed.data : null;
}

export const siteOpWindowSchema = opWindowSchema;
