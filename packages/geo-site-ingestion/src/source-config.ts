import { z } from "zod";
import { LIMITS, MAX_REQUESTS_PER_SECOND } from "./crawl-policy";
import { checkUrl, normalizeHost, type UrlRefusal } from "./net/url-policy";
import { siteOpWindowSchema, siteProfileSchema } from "./profile";
import { isValidCron } from "./schedule";

const hostSchema = z
	.string()
	.trim()
	.min(1)
	.max(253)
	.regex(/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i, "不是合法的域名")
	.transform(normalizeHost);

/**
 * Goes into the User-Agent header, so it has to be a single printable line: a
 * URL or address someone at the site can reach the operators through.
 */
const contactSchema = z
	.string()
	.trim()
	.max(200)
	.regex(/^[\x21-\x7e]+$/, "联系方式只能是不含空格的网址或邮箱");

export const siteSourceConfigSchema = z.object({
	baseUrl: z.string().trim().min(1).max(2000),
	allowedHosts: z.array(hostSchema).min(1).max(10),
	seedUrls: z.array(z.string().trim().min(1).max(2000)).max(200).default([]),
	keyUrls: z.array(z.string().trim().min(1).max(2000)).max(2000).default([]),
	profile: siteProfileSchema,
	requestsPerSecond: z.number().positive().max(MAX_REQUESTS_PER_SECOND).default(1),
	maxPages: z.number().int().min(1).max(LIMITS.hardMaxPages).default(LIMITS.defaultMaxPages),
	maxAssetBytes: z
		.number()
		.int()
		.min(1024)
		.max(100 * 1024 * 1024)
		.default(LIMITS.defaultAssetBytes),
	opWindow: siteOpWindowSchema.nullable().default(null),
	crawlCron: z.string().trim().max(100).refine(isValidCron, "cron 表达式无效").nullable().default(null),
	userAgentContact: contactSchema.nullable().default(null),
	authorizationNote: z.string().trim().max(2000).nullable().default(null),
	enabled: z.boolean().default(true),
});
export type SiteSourceConfig = z.infer<typeof siteSourceConfigSchema>;
export type SiteSourceConfigInput = z.input<typeof siteSourceConfigSchema>;

export interface RefusedUrl {
	field: "baseUrl" | "seedUrls" | "keyUrls";
	url: string;
	reason: UrlRefusal;
}

export interface CheckedSourceUrls {
	baseUrl: string;
	seedUrls: string[];
	keyUrls: string[];
	refused: RefusedUrl[];
}

/**
 * Every URL a source names must sit on its own allowlist. Anything else is
 * refused as a whole rather than quietly dropped, so an injected foreign or
 * internal address is visible to whoever tried it and to the audit log.
 */
export function checkSourceUrls(
	config: Pick<SiteSourceConfig, "baseUrl" | "allowedHosts" | "seedUrls" | "keyUrls">,
): CheckedSourceUrls {
	const policy = { allowedHosts: config.allowedHosts };
	const refused: RefusedUrl[] = [];
	const accept = (field: RefusedUrl["field"], url: string): string | null => {
		const decision = checkUrl(url, policy);
		if (decision.ok) return decision.url;
		refused.push({ field, url, reason: decision.reason });
		return null;
	};
	const baseUrl = accept("baseUrl", config.baseUrl) ?? config.baseUrl;
	const seedUrls = config.seedUrls.map((url) => accept("seedUrls", url)).filter((url): url is string => Boolean(url));
	const keyUrls = config.keyUrls.map((url) => accept("keyUrls", url)).filter((url): url is string => Boolean(url));
	return { baseUrl, seedUrls: [...new Set(seedUrls)], keyUrls: [...new Set(keyUrls)], refused };
}

export function policyVersionOf(config: Pick<SiteSourceConfig, "profile" | "requestsPerSecond" | "maxPages">): string {
	return `${config.profile.id}@${config.profile.version};rps=${config.requestsPerSecond};pages=${config.maxPages}`;
}
