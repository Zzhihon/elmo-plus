import { GEO_PLATFORM_LABELS, type GeoPlatform, type GeoSurfaceMode } from "@workspace/geo-domain";
import type { MetricValue } from "@workspace/geo-reports";
import { CUSTOMER_MODE_LABELS } from "@/server/geo/dashboard-metrics";

export const dashboardKeys = {
	all: (organizationId: string) => ["geo-dashboard", organizationId] as const,
	data: (organizationId: string) => ["geo-dashboard", organizationId, "data"] as const,
	layout: (organizationId: string) => ["geo-dashboard", organizationId, "layout"] as const,
	improvements: (organizationId: string) => ["geo-dashboard", organizationId, "improvements"] as const,
	site: (organizationId: string) => ["geo-dashboard", organizationId, "site"] as const,
};

export function percent(value: MetricValue): string {
	return value.status === "OK" ? `${Math.round(value.rate * 100)}%` : "—";
}

export function shareLabel(share: number | null): string {
	return share === null ? "—" : `${Math.round(share * 100)}%`;
}

export function platformModeLabel(platform: GeoPlatform, mode: GeoSurfaceMode): string {
	return `${GEO_PLATFORM_LABELS[platform]} · ${CUSTOMER_MODE_LABELS[mode]}`;
}

export function errorText(error: unknown): string {
	return error instanceof Error ? error.message : "加载失败，请稍后再试";
}
