import { isIP } from "node:net";
import { normalizeUrl } from "@workspace/geo-evidence";
import type { SiteProfile } from "../profile";

export type UrlRefusal =
	| "INVALID"
	| "PROTOCOL"
	| "CREDENTIALS"
	| "PORT"
	| "IP_LITERAL"
	| "HOST_NOT_ALLOWED"
	| "EXCLUDED"
	| "NOT_INCLUDED"
	| "SENSITIVE_PATH";

export type UrlDecision = { ok: true; url: string; host: string } | { ok: false; reason: UrlRefusal; url: string };

export interface UrlPolicy {
	allowedHosts: readonly string[];
	/** Non-default ports that are also acceptable. Empty in every real source. */
	allowedPorts?: readonly number[];
	include?: readonly string[];
	exclude?: readonly string[];
}

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);
const DEFAULT_PORTS: Record<string, string> = { "http:": "80", "https:": "443" };

/**
 * Areas no public-content crawl has reason to enter, whatever the site. Being able
 * to read them is not permission to.
 */
const SENSITIVE_PATH =
	/(^|\/)(admin|administrator|backend|wp-admin|wp-login|login|logout|signin|signup|register|user|member|cart|checkout|api|cgi-bin|phpmyadmin)(\/|$|\?|\.)|(^|\/)\.(env|git|svn|htaccess)(\/|$)/i;

export const URL_REFUSAL_LABELS: Record<UrlRefusal, string> = {
	INVALID: "不是合法的网址",
	PROTOCOL: "只允许 http 与 https",
	CREDENTIALS: "网址不得携带账号密码",
	PORT: "只允许默认端口",
	IP_LITERAL: "不允许直接使用 IP 地址",
	HOST_NOT_ALLOWED: "域名不在授权白名单内",
	EXCLUDED: "命中排除规则",
	NOT_INCLUDED: "不在采集范围规则内",
	SENSITIVE_PATH: "后台、登录或接口路径不采集",
};

export function normalizeHost(host: string): string {
	return host.trim().toLowerCase().replace(/\.$/, "");
}

function pathAndQuery(url: URL): string {
	return `${url.pathname}${url.search}`;
}

/** Whether a host name is exactly one of the authorized ones; similar-looking domains are not. */
export function isAllowedHost(host: string, allowedHosts: readonly string[]): boolean {
	const normalized = normalizeHost(host);
	return allowedHosts.some((allowed) => normalizeHost(allowed) === normalized);
}

/**
 * The gate every URL passes before it is queued, fetched, or followed as a
 * redirect. It decides on the URL alone; the network layer separately checks
 * what the host resolves to.
 */
export function checkUrl(input: string, policy: UrlPolicy, base?: string): UrlDecision {
	let parsed: URL;
	try {
		parsed = new URL(input.trim(), base);
	} catch {
		return { ok: false, reason: "INVALID", url: input };
	}
	if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) return { ok: false, reason: "PROTOCOL", url: input };
	if (parsed.username || parsed.password) return { ok: false, reason: "CREDENTIALS", url: input };
	if (
		parsed.port &&
		parsed.port !== DEFAULT_PORTS[parsed.protocol] &&
		!policy.allowedPorts?.includes(Number(parsed.port))
	) {
		return { ok: false, reason: "PORT", url: input };
	}
	const host = normalizeHost(parsed.hostname);
	if (isIP(host.replace(/^\[|\]$/g, ""))) return { ok: false, reason: "IP_LITERAL", url: input };
	if (!isAllowedHost(host, policy.allowedHosts)) return { ok: false, reason: "HOST_NOT_ALLOWED", url: input };

	const url = normalizeUrl(parsed.toString());
	if (!url) return { ok: false, reason: "INVALID", url: input };
	const target = pathAndQuery(new URL(url));
	if (SENSITIVE_PATH.test(target)) return { ok: false, reason: "SENSITIVE_PATH", url };
	if (policy.exclude?.some((pattern) => new RegExp(pattern).test(target))) {
		return { ok: false, reason: "EXCLUDED", url };
	}
	if (policy.include?.length && !policy.include.some((pattern) => new RegExp(pattern).test(target))) {
		return { ok: false, reason: "NOT_INCLUDED", url };
	}
	return { ok: true, url, host };
}

export function urlPolicyOf(allowedHosts: readonly string[], profile: SiteProfile): UrlPolicy {
	return { allowedHosts, include: profile.scope.include, exclude: profile.scope.exclude };
}

/** For redirects: only the host allowlist and the hard rules apply, not the crawl scope patterns. */
export function redirectPolicyOf(allowedHosts: readonly string[], allowedPorts?: readonly number[]): UrlPolicy {
	return { allowedHosts, allowedPorts };
}
