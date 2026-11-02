import { z } from "zod";

function isValidRegex(pattern: string): boolean {
	try {
		new RegExp(pattern, "i");
		return true;
	} catch {
		return false;
	}
}

const pattern = z.string().min(1).max(300).refine(isValidRegex, "不是合法的正则表达式");
const keyword = z.string().trim().min(1).max(40);
const fieldPath = z.string().max(120);

const contentCheckSchema = z.object({
	/** Any of these in the page text satisfies the check. Replaces the built-in list when given. */
	keywords: z.array(keyword).max(60).optional(),
	/** Any of these parsed fields holding a value satisfies the check. */
	fieldPaths: z.array(fieldPath).max(20).optional(),
});

/**
 * The `audit` block of a site profile. Every key is optional; anything left out
 * falls back to the defaults below, so a profile without it audits sensibly.
 */
export const siteAuditConfigSchema = z.object({
	disabledRules: z.array(z.string().max(80)).max(100).optional(),
	/** Display width, CJK characters counting two. */
	titleMaxWidth: z.number().int().min(10).max(300).optional(),
	minTextLength: z.number().int().min(0).max(10_000).optional(),
	/** A detail page with images and no more text than this is image-only. */
	imageOnlyMaxText: z.number().int().min(0).max(2_000).optional(),
	altMissingRatio: z.number().min(0).max(1).optional(),
	/** Added to the built-in placeholder patterns (case-insensitive). */
	placeholderPatterns: z.array(pattern).max(30).optional(),
	/** Added to the built-in "this list is empty" patterns (case-insensitive). */
	emptySectionPatterns: z.array(pattern).max(30).optional(),
	/** User agents whose exclusion in robots.txt is reported. Replaces the built-in list when given. */
	aiCrawlers: z.array(z.string().trim().min(1).max(60)).max(40).optional(),
	productChecks: z
		.object({
			industries: contentCheckSchema.optional(),
			selection: contentCheckSchema.optional(),
			paramSource: contentCheckSchema.optional(),
			caseRefs: contentCheckSchema.optional(),
		})
		.optional(),
});
export type SiteAuditConfigInput = z.infer<typeof siteAuditConfigSchema>;

export const PRODUCT_CHECKS = ["industries", "selection", "paramSource", "caseRefs"] as const;
export type ProductCheck = (typeof PRODUCT_CHECKS)[number];

export interface ResolvedContentCheck {
	keywords: string[];
	fieldPaths: string[];
}

export interface ResolvedAuditConfig {
	disabledRules: Set<string>;
	titleMaxWidth: number;
	minTextLength: number;
	imageOnlyMaxText: number;
	altMissingRatio: number;
	placeholderPatterns: RegExp[];
	emptySectionPatterns: RegExp[];
	aiCrawlers: string[];
	productChecks: Record<ProductCheck, ResolvedContentCheck>;
}

/** Whole-text patterns: the body is nothing but test or placeholder copy. */
const PLACEHOLDER_PATTERNS = [
	"lorem ipsum",
	"^\\s*[a-z0-9]{1,12}\\s*$",
	"^\\s*(测试|test|testing|demo|示例文字|内容待补充|待补充|待完善|敬请期待|正在建设中?|建设中|即将上线|coming soon|under construction)[。.!！\\s]*$",
	"^(.)\\1{5,}$",
];

const EMPTY_SECTION_PATTERNS = [
	"暂无(相关)?(数据|内容|信息|记录|资料)",
	"没有(找到)?(相关|任何)?(数据|内容|信息|记录)",
	"no (data|records|results|content)",
	"nothing (found|here)",
];

export const DEFAULT_AI_CRAWLERS = [
	"GPTBot",
	"OAI-SearchBot",
	"ChatGPT-User",
	"ClaudeBot",
	"Claude-SearchBot",
	"PerplexityBot",
	"Google-Extended",
	"Bytespider",
	"Baiduspider",
	"YisouSpider",
	"Sogou web spider",
	"360Spider",
	"bingbot",
];

const DEFAULT_PRODUCT_KEYWORDS: Record<ProductCheck, string[]> = {
	industries: [
		"应用行业",
		"适用行业",
		"应用领域",
		"适用领域",
		"应用场景",
		"适用场景",
		"适用场所",
		"适用范围",
		"使用场合",
		"广泛应用于",
		"行业应用",
	],
	selection: ["选型", "如何选择", "怎么选", "选购", "常见问题", "问答", "FAQ", "订货须知", "订货说明", "注意事项"],
	paramSource: [
		"执行标准",
		"符合标准",
		"依据标准",
		"产品标准",
		"标准号",
		"GB/T",
		"GB",
		"JB/T",
		"DL/T",
		"IEC",
		"检测报告",
		"型式试验",
		"试验报告",
		"认证",
	],
	caseRefs: ["案例", "工程业绩", "项目业绩", "应用实例", "典型项目", "成功应用", "已应用于"],
};

export function resolveAuditConfig(input: SiteAuditConfigInput | null | undefined): ResolvedAuditConfig {
	const config = input ?? {};
	const regexes = (patterns: string[]) => patterns.map((source) => new RegExp(source, "iu"));
	const checks = config.productChecks ?? {};
	const productChecks = Object.fromEntries(
		PRODUCT_CHECKS.map((check) => [
			check,
			{
				keywords: checks[check]?.keywords ?? DEFAULT_PRODUCT_KEYWORDS[check],
				fieldPaths: checks[check]?.fieldPaths ?? [],
			},
		]),
	) as Record<ProductCheck, ResolvedContentCheck>;
	return {
		disabledRules: new Set(config.disabledRules ?? []),
		titleMaxWidth: config.titleMaxWidth ?? 60,
		minTextLength: config.minTextLength ?? 150,
		imageOnlyMaxText: config.imageOnlyMaxText ?? 40,
		altMissingRatio: config.altMissingRatio ?? 0.5,
		placeholderPatterns: regexes([...PLACEHOLDER_PATTERNS, ...(config.placeholderPatterns ?? [])]),
		emptySectionPatterns: regexes([...EMPTY_SECTION_PATTERNS, ...(config.emptySectionPatterns ?? [])]),
		aiCrawlers: config.aiCrawlers ?? DEFAULT_AI_CRAWLERS,
		productChecks,
	};
}
