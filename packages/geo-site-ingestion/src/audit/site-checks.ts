import { isAllowedByRobots, parseRobots } from "../net/robots";
import type { SafeFetchResult } from "../net/safe-fetch";
import { isAllowedHost } from "../net/url-policy";
import { SITE_AUDIT_RULES } from "./catalog";
import type { ResolvedAuditConfig } from "./config";
import type { AuditDetection, KnownPage } from "./rules";

export type RobotsProbe =
	| { kind: "SKIPPED"; reason: string }
	| { kind: "FILE"; url: string; status: number; text: string }
	| { kind: "NOT_FOUND"; url: string; status: number | null; detail: string | null }
	| { kind: "UNAVAILABLE"; url: string; status: number | null; detail: string };

export interface SitemapFileProbe {
	url: string;
	/** Named in robots.txt rather than guessed at the default location. */
	declared: boolean;
	status: number | null;
	error: string | null;
	valid: boolean;
	pages: string[];
	nested: string[];
}

export type SitemapProbe = { kind: "SKIPPED"; reason: string } | { kind: "CHECKED"; files: SitemapFileProbe[] };

export type HttpsProbe =
	| { kind: "SKIPPED"; reason: string }
	| { kind: "OK"; url: string; finalUrl: string; status: number }
	| { kind: "TIMEOUT" | "CERTIFICATE" | "UNREACHABLE"; url: string; detail: string }
	| { kind: "ERROR_STATUS"; url: string; status: number }
	| { kind: "DOWNGRADE"; url: string; finalUrl: string; status: number };

export interface SiteProbes {
	baseUrl: string;
	robots: RobotsProbe;
	sitemap: SitemapProbe;
	https: HttpsProbe;
}

export interface SiteCheckContext {
	config: ResolvedAuditConfig;
	allowedHosts: readonly string[];
	knownPages: ReadonlyMap<string, KnownPage>;
	/** Pages that should be in a sitemap: audited, active and not marked noindex. */
	indexableUrls: readonly string[];
}

const TLS_FAILURE =
	/certificate|cert_|self[- ]signed|altname|unable to verify|unable to get (local )?issuer|ssl|tls|handshake|wrong version number/i;

/** Splits an HTTPS probe so a timeout and a certificate problem are recorded as different findings. */
export function classifyHttpsProbe(url: string, result: SafeFetchResult): HttpsProbe {
	if (result.ok) {
		if (new URL(result.finalUrl).protocol === "http:") {
			return { kind: "DOWNGRADE", url, finalUrl: result.finalUrl, status: result.status };
		}
		if (result.status >= 400) return { kind: "ERROR_STATUS", url, status: result.status };
		return { kind: "OK", url, finalUrl: result.finalUrl, status: result.status };
	}
	switch (result.code) {
		case "TIMEOUT":
			return { kind: "TIMEOUT", url, detail: result.detail };
		case "TOO_LARGE":
		case "MIME_REJECTED":
			if (result.status && result.status < 400) {
				return { kind: "OK", url, finalUrl: result.finalUrl, status: result.status };
			}
			return { kind: "ERROR_STATUS", url, status: result.status ?? 0 };
		case "URL_REFUSED":
			return { kind: "SKIPPED", reason: result.detail };
		case "NETWORK":
			return TLS_FAILURE.test(result.detail)
				? { kind: "CERTIFICATE", url, detail: result.detail }
				: { kind: "UNREACHABLE", url, detail: result.detail };
		default:
			return { kind: "UNREACHABLE", url, detail: result.detail };
	}
}

/** RFC 9309 semantics, as the crawler applies them: 4xx is "no robots.txt", 5xx and no answer are "unavailable". */
export function classifyRobotsProbe(url: string, result: SafeFetchResult, text: string | null): RobotsProbe {
	if (!result.ok) {
		if (result.code === "MIME_REJECTED") {
			return { kind: "NOT_FOUND", url, status: result.status ?? null, detail: "返回的不是纯文本，按不存在处理" };
		}
		return { kind: "UNAVAILABLE", url, status: result.status ?? null, detail: result.detail };
	}
	if (result.status >= 200 && result.status < 300)
		return { kind: "FILE", url, status: result.status, text: text ?? "" };
	if (result.status >= 400 && result.status < 500)
		return { kind: "NOT_FOUND", url, status: result.status, detail: null };
	return { kind: "UNAVAILABLE", url, status: result.status, detail: `HTTP ${result.status}` };
}

/** A token no robots.txt names, so the policy found is the `*` group's. */
const GENERIC_AGENT = "elmo-geo-site-audit-generic-agent";

type Emit = (ruleId: string, evidence: AuditDetection["evidence"]) => void;

function robotsRules(probe: RobotsProbe, ctx: SiteCheckContext, emit: Emit, evaluated: Set<string>): void {
	if (probe.kind === "SKIPPED") return;
	evaluated.add("robots.missing");
	evaluated.add("robots.unreachable");
	if (probe.kind === "NOT_FOUND") {
		emit("robots.missing", {
			summary: `${probe.url} 返回 ${probe.status ?? "非文本内容"}`,
			url: probe.url,
			status: probe.status,
			detail: probe.detail,
		});
		evaluated.add("robots.blocks_site");
		evaluated.add("robots.blocks_ai_crawlers");
		return;
	}
	if (probe.kind === "UNAVAILABLE") {
		emit("robots.unreachable", {
			summary: `${probe.url} 无法获取：${probe.detail}`,
			url: probe.url,
			status: probe.status,
			detail: probe.detail,
		});
		return;
	}
	for (const id of ["robots.blocks_site", "robots.blocks_ai_crawlers", "robots.sitemap_undeclared"]) evaluated.add(id);
	const generic = parseRobots(probe.text, GENERIC_AGENT, probe.status);
	const blocksSite = !isAllowedByRobots(generic, "/");
	if (blocksSite) {
		emit("robots.blocks_site", { summary: "User-agent: * 禁止访问 /", url: probe.url });
	} else {
		const blocked = ctx.config.aiCrawlers.filter(
			(agent) => !isAllowedByRobots(parseRobots(probe.text, agent, probe.status), "/"),
		);
		if (blocked.length > 0) {
			emit("robots.blocks_ai_crawlers", {
				summary: `禁止访问 / 的爬虫：${blocked.join("、")}`,
				url: probe.url,
				crawlers: blocked,
			});
		}
	}
	if (generic.sitemaps.length === 0) {
		emit("robots.sitemap_undeclared", { summary: "robots.txt 中没有 Sitemap 行", url: probe.url });
	}
}

function staleSitemapUrls(listed: Set<string>, ctx: SiteCheckContext): Array<{ url: string; reason: string }> {
	return [...listed].flatMap((url) => {
		if (!isAllowedHost(new URL(url).hostname, ctx.allowedHosts)) return [{ url, reason: "不在授权域名内" }];
		const known = ctx.knownPages.get(url);
		if (known?.status === "GONE") return [{ url, reason: `HTTP ${known.httpStatus ?? 404}` }];
		if (known?.status === "REDIRECTED") return [{ url, reason: `重定向到 ${known.canonicalUrl ?? "其他网址"}` }];
		return [];
	});
}

function sitemapRules(probe: SitemapProbe, ctx: SiteCheckContext, emit: Emit, evaluated: Set<string>): void {
	if (probe.kind === "SKIPPED") return;
	for (const rule of ["sitemap.missing", "sitemap.invalid", "sitemap.stale_urls", "sitemap.incomplete"]) {
		evaluated.add(rule);
	}
	const files = probe.files.map((file) => ({ url: file.url, status: file.status, error: file.error }));
	const answered = probe.files.filter((file) => file.status !== null && file.status >= 200 && file.status < 300);
	if (answered.length === 0) {
		emit("sitemap.missing", { summary: `${probe.files.map((file) => file.url).join("、")} 均无法获取`, files });
		return;
	}
	const usable = answered.filter((file) => file.valid && file.pages.length + file.nested.length > 0);
	if (usable.length === 0) {
		emit("sitemap.invalid", { summary: answered[0].error ?? "站点地图中没有网址", files });
		return;
	}

	const listed = new Set(usable.flatMap((file) => file.pages));
	const stale = staleSitemapUrls(listed, ctx);
	const unreachableFiles = probe.files.filter((file) => file.declared && !usable.includes(file));
	if (stale.length > 0 || unreachableFiles.length > 0) {
		emit("sitemap.stale_urls", {
			summary:
				stale.length > 0
					? `${stale.length} 个网址失效或越界，如 ${stale[0].url}`
					: `robots.txt 声明的 ${unreachableFiles[0].url} 无法使用`,
			count: stale.length,
			urls: stale.slice(0, 20),
			unreachableFiles: unreachableFiles.map((file) => ({ url: file.url, status: file.status, error: file.error })),
		});
	}

	const missing = ctx.indexableUrls.filter((url) => !listed.has(url));
	if (ctx.indexableUrls.length > 0 && missing.length >= 3 && missing.length / ctx.indexableUrls.length >= 0.2) {
		emit("sitemap.incomplete", {
			summary: `${ctx.indexableUrls.length} 个正常页面中 ${missing.length} 个不在站点地图里`,
			total: ctx.indexableUrls.length,
			missing: missing.length,
			samples: missing.slice(0, 20),
		});
	}
}

function httpsRules(probe: HttpsProbe, baseUrl: string, emit: Emit, evaluated: Set<string>): void {
	if (probe.kind === "SKIPPED") return;
	for (const rule of SITE_AUDIT_RULES.filter((entry) => entry.id.startsWith("https."))) evaluated.add(rule.id);
	switch (probe.kind) {
		case "OK":
			if (new URL(baseUrl).protocol === "http:") {
				emit("https.not_enforced", {
					summary: `${probe.url} 可正常访问（HTTP ${probe.status}），站点登记地址仍为 ${baseUrl}`,
					url: probe.url,
					status: probe.status,
				});
			}
			return;
		case "TIMEOUT":
			emit("https.timeout", { summary: `${probe.url} 超时：${probe.detail}`, url: probe.url, detail: probe.detail });
			return;
		case "CERTIFICATE":
			emit("https.certificate", {
				summary: `${probe.url} 证书错误：${probe.detail}`,
				url: probe.url,
				detail: probe.detail,
			});
			return;
		case "UNREACHABLE":
			emit("https.unreachable", {
				summary: `${probe.url} 无法连接：${probe.detail}`,
				url: probe.url,
				detail: probe.detail,
			});
			return;
		case "ERROR_STATUS":
			emit("https.error_status", {
				summary: `${probe.url} 返回 HTTP ${probe.status}`,
				url: probe.url,
				status: probe.status,
			});
			return;
		case "DOWNGRADE":
			emit("https.downgrade", {
				summary: `${probe.url} 跳转到 ${probe.finalUrl}`,
				url: probe.url,
				finalUrl: probe.finalUrl,
			});
			return;
	}
}

/**
 * Site-wide checks from what the probes saw. A probe that was skipped (circuit
 * open, host busy) evaluates nothing, so earlier findings stay as they were.
 */
export function evaluateSiteChecks(
	probes: SiteProbes,
	ctx: SiteCheckContext,
): { detections: AuditDetection[]; evaluatedRuleIds: string[] } {
	const detections: AuditDetection[] = [];
	const evaluated = new Set<string>();
	const emit: Emit = (ruleId, evidence) => {
		detections.push({ ruleId, pageId: null, versionId: null, evidence });
	};
	robotsRules(probes.robots, ctx, emit, evaluated);
	sitemapRules(probes.sitemap, ctx, emit, evaluated);
	httpsRules(probes.https, probes.baseUrl, emit, evaluated);
	const disabled = ctx.config.disabledRules;
	return {
		detections: detections.filter((detection) => !disabled.has(detection.ruleId)),
		evaluatedRuleIds: [...evaluated].filter((id) => !disabled.has(id)),
	};
}
