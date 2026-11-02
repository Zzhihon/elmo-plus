import { Card, CardContent, CardHeader, CardTitle } from "@workspace/ui/components/card";
import type { ReactNode } from "react";
import { type GeoBadgeTone, GeoStatusBadge } from "@/components/geo/shell/status-badge";
import { formatDateTime } from "@/components/geo/site-pages/site-labels";
import type { getSiteAuditOverviewFn } from "@/server/geo/site-audit";

type Overview = Awaited<ReturnType<typeof getSiteAuditOverviewFn>>;
type SiteChecks = NonNullable<Overview["siteChecks"]>;

function Row({ label, badge, children }: { label: string; badge: ReactNode; children?: ReactNode }) {
	return (
		<div className="flex flex-col gap-1 border-b py-3 last:border-b-0 sm:flex-row sm:items-start sm:gap-4">
			<div className="w-28 shrink-0 text-sm font-medium">{label}</div>
			<div className="shrink-0">{badge}</div>
			<div className="min-w-0 flex-1 text-sm text-muted-foreground break-all">{children}</div>
		</div>
	);
}

function badge(label: string, tone: GeoBadgeTone) {
	return <GeoStatusBadge label={label} tone={tone} />;
}

function RobotsRow({ robots }: { robots: SiteChecks["robots"] }) {
	if (!robots) return null;
	switch (robots.kind) {
		case "FILE":
			return (
				<Row label="robots.txt" badge={badge(`存在（HTTP ${robots.status}）`, "success")}>
					{robots.url}
				</Row>
			);
		case "NOT_FOUND":
			return (
				<Row label="robots.txt" badge={badge("不存在", "warning")}>
					{robots.url} 返回 {robots.status ?? "非文本内容"}
					{robots.detail ? `，${robots.detail}` : ""}
				</Row>
			);
		case "UNAVAILABLE":
			return (
				<Row label="robots.txt" badge={badge("无法获取", "danger")}>
					{robots.url}：{robots.detail}
				</Row>
			);
		default:
			return (
				<Row label="robots.txt" badge={badge("未检查", "neutral")}>
					{robots.reason}
				</Row>
			);
	}
}

function SitemapRow({ sitemap }: { sitemap: SiteChecks["sitemap"] }) {
	if (!sitemap) return null;
	if (sitemap.kind === "SKIPPED") {
		return (
			<Row label="站点地图" badge={badge("未检查", "neutral")}>
				{sitemap.reason}
			</Row>
		);
	}
	const usable = sitemap.files.filter((file) => file.valid && file.pages + file.nested > 0);
	const pages = usable.reduce((sum, file) => sum + file.pages, 0);
	return (
		<Row
			label="站点地图"
			badge={usable.length > 0 ? badge(`有效，${pages} 个网址`, "success") : badge("缺失或无效", "danger")}
		>
			<ul className="flex flex-col gap-1">
				{sitemap.files.map((file) => (
					<li key={file.url}>
						{file.url}：{file.status === null ? "无响应" : `HTTP ${file.status}`}
						{file.valid ? `，${file.pages} 个网址` : file.error ? `，${file.error}` : ""}
						{file.declared ? "（robots.txt 声明）" : ""}
					</li>
				))}
			</ul>
		</Row>
	);
}

const HTTPS_LABELS: Record<string, { label: string; tone: GeoBadgeTone }> = {
	OK: { label: "可用", tone: "success" },
	TIMEOUT: { label: "超时", tone: "danger" },
	CERTIFICATE: { label: "证书或握手错误", tone: "danger" },
	UNREACHABLE: { label: "无法连接", tone: "danger" },
	ERROR_STATUS: { label: "返回错误状态", tone: "warning" },
	DOWNGRADE: { label: "跳转回 HTTP", tone: "warning" },
	SKIPPED: { label: "未检查", tone: "neutral" },
};

function HttpsRow({ https }: { https: SiteChecks["https"] }) {
	if (!https) return null;
	const entry = HTTPS_LABELS[https.kind];
	const detail =
		https.kind === "SKIPPED"
			? https.reason
			: https.kind === "OK"
				? `${https.url}，HTTP ${https.status}`
				: https.kind === "ERROR_STATUS"
					? `${https.url}，HTTP ${https.status}`
					: https.kind === "DOWNGRADE"
						? `${https.url} → ${https.finalUrl}`
						: `${https.url}：${https.detail}`;
	return (
		<Row label="HTTPS" badge={badge(entry.label, entry.tone)}>
			{detail}
		</Row>
	);
}

/**
 * The last robots.txt, sitemap and HTTPS probe. These say whether crawlers can
 * reach the site, which is a precondition for, not evidence of, being cited.
 */
export function SiteChecksPanel({ siteChecks }: { siteChecks: Overview["siteChecks"] }) {
	return (
		<Card>
			<CardHeader>
				<CardTitle className="text-base">站点级检查</CardTitle>
				<p className="text-sm text-muted-foreground">
					{siteChecks?.checkedAt
						? `检查于 ${formatDateTime(siteChecks.checkedAt)}。请求经过与官网采集相同的域名白名单、限速和熔断。`
						: "还没有完成过站点级检查。全站采集完成后的审计或手动审计会检查 robots.txt、站点地图和 HTTPS。"}
				</p>
			</CardHeader>
			{siteChecks?.checkedAt && (
				<CardContent>
					<RobotsRow robots={siteChecks.robots} />
					<SitemapRow sitemap={siteChecks.sitemap} />
					<HttpsRow https={siteChecks.https} />
				</CardContent>
			)}
		</Card>
	);
}
