import {
	GEO_PLATFORM_LABELS,
	GEO_SURFACE_MODE_LABELS,
	type GeoPlatform,
	type GeoSurfaceMode,
} from "@workspace/geo-domain";
import { type GeoBadgeTone, GeoStatusBadge } from "./status-badge";

const SURFACE_TONES: Record<GeoSurfaceMode, GeoBadgeTone> = {
	LIVE_SURFACE: "info",
	BROWSER_AGENT: "info",
	MODEL_API: "warning",
	MANUAL_EVIDENCE: "neutral",
};

/** Always shown beside a sampled answer: a model API result must never read as the product's own answer. */
export function GeoSurfaceModeBadge({ mode }: { mode: GeoSurfaceMode }) {
	return <GeoStatusBadge label={GEO_SURFACE_MODE_LABELS[mode]} tone={SURFACE_TONES[mode]} />;
}

export function GeoPlatformBadge({ platform }: { platform: GeoPlatform }) {
	return <GeoStatusBadge label={GEO_PLATFORM_LABELS[platform]} />;
}

export function GeoFactPendingBadge() {
	return <GeoStatusBadge label="来源已采集、事实待审核" tone="warning" />;
}

export function GeoFactApprovedBadge() {
	return <GeoStatusBadge label="已审核事实" tone="success" />;
}
