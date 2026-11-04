import type { GeoPriority } from "@workspace/geo-domain";
import { type GeoBadgeTone, GeoStatusBadge } from "@/components/geo/shell/status-badge";

export const recommendationKeys = {
	all: (organizationId: string) => ["geo-recommendations", organizationId] as const,
	list: (organizationId: string) => ["geo-recommendations", organizationId, "list"] as const,
	comparison: (organizationId: string) => ["geo-recommendations", organizationId, "comparison"] as const,
};

const PRIORITY: Record<GeoPriority, { label: string; tone: GeoBadgeTone }> = {
	P0: { label: "最优先", tone: "danger" },
	P1: { label: "优先", tone: "warning" },
	P2: { label: "建议", tone: "info" },
	P3: { label: "可选", tone: "neutral" },
};

export function RecommendationPriorityBadge({ priority }: { priority: GeoPriority }) {
	const entry = PRIORITY[priority];
	return <GeoStatusBadge label={entry.label} tone={entry.tone} />;
}

export function formatRate(rate: number | null): string {
	return rate === null ? "数据不足" : `${Math.round(rate * 100)}%`;
}
