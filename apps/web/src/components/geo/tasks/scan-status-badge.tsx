import type { GeoScanStatus } from "@workspace/geo-domain";
import { type GeoBadgeTone, GeoStatusBadge } from "@/components/geo/shell/status-badge";
import { SCAN_STATUS_LABELS } from "./labels";

const TONES: Record<GeoScanStatus, GeoBadgeTone> = {
	PENDING: "neutral",
	CLEAN: "success",
	INFECTED: "danger",
	UNSCANNED: "warning",
};

/** UNSCANNED means no scanner was configured when the file arrived, which the viewer must be able to see. */
export function GeoScanStatusBadge({ status }: { status: GeoScanStatus }) {
	return (
		<GeoStatusBadge
			label={SCAN_STATUS_LABELS[status]}
			tone={TONES[status]}
			className={status === "UNSCANNED" ? "cursor-help" : undefined}
		/>
	);
}
