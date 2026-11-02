import type { GeoFindingSeverity, GeoFindingStatus, GeoSiteAuditRunStatus } from "@workspace/geo-domain";
import {
	SITE_AUDIT_DEPARTMENT_LABELS,
	SITE_AUDIT_FINDING_STATUS_LABELS,
	SITE_AUDIT_SEVERITY_LABELS,
	type SiteAuditDepartment,
} from "@workspace/geo-site-ingestion/audit/catalog";
import { type GeoBadgeTone, GeoStatusBadge } from "@/components/geo/shell/status-badge";

export const siteAuditKeys = {
	all: (organizationId: string) => ["geo-site-audit", organizationId] as const,
	sources: (organizationId: string) => ["geo-site-audit", organizationId, "sources"] as const,
	overview: (organizationId: string, siteSourceId: string) =>
		["geo-site-audit", organizationId, "overview", siteSourceId] as const,
	groups: (organizationId: string, filters: object, page: number) =>
		["geo-site-audit", organizationId, "groups", filters, page] as const,
	finding: (organizationId: string, findingId: string) =>
		["geo-site-audit", organizationId, "finding", findingId] as const,
	runs: (organizationId: string, siteSourceId: string, page: number) =>
		["geo-site-audit", organizationId, "runs", siteSourceId, page] as const,
	prompts: (organizationId: string) => ["geo-site-audit", organizationId, "prompts"] as const,
};

const SEVERITY_TONES: Record<GeoFindingSeverity, GeoBadgeTone> = {
	HIGH: "danger",
	MEDIUM: "warning",
	LOW: "info",
	INFO: "neutral",
};

export function SeverityBadge({ severity }: { severity: GeoFindingSeverity }) {
	return <GeoStatusBadge label={`${SITE_AUDIT_SEVERITY_LABELS[severity]}严重度`} tone={SEVERITY_TONES[severity]} />;
}

const STATUS_TONES: Record<GeoFindingStatus, GeoBadgeTone> = {
	OPEN: "warning",
	TASKED: "info",
	RESOLVED: "success",
	DISMISSED: "neutral",
};

export function FindingStatusBadge({ status }: { status: GeoFindingStatus }) {
	return <GeoStatusBadge label={SITE_AUDIT_FINDING_STATUS_LABELS[status]} tone={STATUS_TONES[status]} />;
}

const RUN_STATUS: Record<GeoSiteAuditRunStatus, { label: string; tone: GeoBadgeTone }> = {
	QUEUED: { label: "排队中", tone: "neutral" },
	RUNNING: { label: "审计中", tone: "info" },
	SUCCEEDED: { label: "已完成", tone: "success" },
	FAILED: { label: "失败", tone: "danger" },
};

export function AuditRunStatusBadge({ status }: { status: GeoSiteAuditRunStatus }) {
	const entry = RUN_STATUS[status];
	return <GeoStatusBadge label={entry.label} tone={entry.tone} />;
}

export function departmentLabel(value: string | null | undefined): string {
	if (!value) return "—";
	return SITE_AUDIT_DEPARTMENT_LABELS[value as SiteAuditDepartment] ?? value;
}

export function requesterLabel(actorId: string): string {
	if (actorId === "system:site-audit") return "官网采集完成后自动执行";
	if (actorId.startsWith("system:")) return "系统";
	if (actorId.startsWith("apikey:")) return "API 调用";
	return "手动发起";
}
