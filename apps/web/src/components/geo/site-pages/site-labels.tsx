import type {
	GeoCrawlItemOutcome,
	GeoCrawlStatus,
	GeoParseStatus,
	GeoSitePageStatus,
	GeoSiteQaVerdict,
} from "@workspace/geo-domain";
import { type GeoBadgeTone, GeoStatusBadge } from "@/components/geo/shell/status-badge";

export const siteQueryKeys = {
	all: ["geo-site"] as const,
	sites: (organizationId: string) => ["geo-site", organizationId, "sites"] as const,
	site: (organizationId: string, siteId: string) => ["geo-site", organizationId, "site", siteId] as const,
	runs: (organizationId: string, siteId: string, page: number) =>
		["geo-site", organizationId, "runs", siteId, page] as const,
	run: (organizationId: string, runId: string) => ["geo-site", organizationId, "run", runId] as const,
	pages: (organizationId: string, filters: object, page: number) =>
		["geo-site", organizationId, "pages", filters, page] as const,
	page: (organizationId: string, pageId: string) => ["geo-site", organizationId, "page", pageId] as const,
	version: (organizationId: string, versionId: string) => ["geo-site", organizationId, "version", versionId] as const,
	snapshot: (organizationId: string, versionId: string) => ["geo-site", organizationId, "snapshot", versionId] as const,
	coverage: (organizationId: string, siteId: string) => ["geo-site", organizationId, "coverage", siteId] as const,
	qaSamples: (organizationId: string, siteId: string) => ["geo-site", organizationId, "qa", siteId] as const,
	qaSample: (organizationId: string, sampleId: string) => ["geo-site", organizationId, "qa-sample", sampleId] as const,
};

const PAGE_STATUS: Record<GeoSitePageStatus, { label: string; tone: GeoBadgeTone }> = {
	ACTIVE: { label: "正常", tone: "success" },
	REDIRECTED: { label: "已重定向", tone: "warning" },
	GONE: { label: "已失效", tone: "danger" },
	BLOCKED: { label: "已阻断", tone: "danger" },
	ERROR: { label: "抓取异常", tone: "warning" },
};

export const PAGE_STATUS_LABELS = Object.fromEntries(
	Object.entries(PAGE_STATUS).map(([key, value]) => [key, value.label]),
) as Record<GeoSitePageStatus, string>;

export function SitePageStatusBadge({ status }: { status: string }) {
	const entry = PAGE_STATUS[status as GeoSitePageStatus] ?? { label: status, tone: "neutral" as const };
	return <GeoStatusBadge label={entry.label} tone={entry.tone} />;
}

const PARSE_STATUS: Record<GeoParseStatus, { label: string; tone: GeoBadgeTone }> = {
	PENDING: { label: "待解析", tone: "neutral" },
	PARSED: { label: "已解析", tone: "success" },
	FAILED: { label: "解析失败", tone: "danger" },
	SKIPPED: { label: "附件不解析", tone: "neutral" },
};

export const PARSE_STATUS_LABELS = Object.fromEntries(
	Object.entries(PARSE_STATUS).map(([key, value]) => [key, value.label]),
) as Record<GeoParseStatus, string>;

export function ParseStatusBadge({ status }: { status: string | null }) {
	if (!status) return <GeoStatusBadge label="无版本" />;
	const entry = PARSE_STATUS[status as GeoParseStatus] ?? { label: status, tone: "neutral" as const };
	return <GeoStatusBadge label={entry.label} tone={entry.tone} />;
}

const CRAWL_STATUS: Record<GeoCrawlStatus, { label: string; tone: GeoBadgeTone }> = {
	QUEUED: { label: "排队中", tone: "neutral" },
	RUNNING: { label: "采集中", tone: "info" },
	PAUSED: { label: "已暂停", tone: "warning" },
	SUCCEEDED: { label: "已完成", tone: "success" },
	PARTIAL: { label: "部分完成", tone: "warning" },
	FAILED: { label: "失败", tone: "danger" },
	CANCELLED: { label: "已取消", tone: "neutral" },
};

export function CrawlStatusBadge({ status }: { status: string }) {
	const entry = CRAWL_STATUS[status as GeoCrawlStatus] ?? { label: status, tone: "neutral" as const };
	return <GeoStatusBadge label={entry.label} tone={entry.tone} />;
}

export const OUTCOME_LABELS: Record<GeoCrawlItemOutcome, string> = {
	NEW_VERSION: "新版本",
	UNCHANGED: "未变化",
	DUPLICATE: "重复网址",
	REDIRECTED: "重定向",
	GONE: "已失效（404/410）",
	AUTH_REQUIRED: "需要鉴权（401/403）",
	CLIENT_ERROR: "客户端错误",
	SERVER_ERROR: "服务端错误",
	NETWORK_ERROR: "网络错误或超时",
	REDIRECT_BLOCKED: "越界重定向已阻断",
	ADDRESS_BLOCKED: "非公网地址已阻断",
	MIME_REJECTED: "内容类型不符",
	TOO_LARGE: "超过大小上限",
	ROBOTS_DISALLOWED: "robots 禁止",
	OUT_OF_SCOPE: "超出采集范围",
	NOFOLLOW: "nofollow 未跟随",
	BUDGET_EXCEEDED: "超出预算",
	ASSET_RECORDED: "附件已登记",
	ASSET_STORED: "附件已保存",
	CIRCUIT_OPEN: "熔断中",
};

export const ENTITY_KIND_LABELS: Record<string, string> = {
	PRODUCT: "产品",
	CASE: "案例",
	NEWS: "新闻",
	COMPANY: "企业",
	QUALIFICATION: "资质",
	SERVICE: "服务",
};

export const QA_VERDICT_LABELS: Record<GeoSiteQaVerdict, string> = {
	CORRECT: "正确",
	INCORRECT: "错误",
	NOT_APPLICABLE: "不适用",
};

export const QA_FIELD_LABELS: Record<string, string> = {
	title: "标题",
	category: "栏目归类",
	publishedAt: "发布日期",
	text: "正文",
	images: "图片链接",
};

export function formatDateTime(value: Date | string | null | undefined): string {
	if (!value) return "—";
	return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

export function formatPercent(value: number | null | undefined, digits = 1): string {
	if (value === null || value === undefined || Number.isNaN(value)) return "—";
	return `${(value * 100).toFixed(digits)}%`;
}

export function formatNumber(value: number | null | undefined): string {
	if (value === null || value === undefined) return "—";
	return value.toLocaleString("zh-CN");
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : "操作失败，请稍后重试";
}
