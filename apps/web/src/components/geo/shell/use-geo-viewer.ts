import { useRouteContext } from "@tanstack/react-router";
import { can, type GeoPermission } from "@workspace/geo-domain";
import { useCallback } from "react";
import type { GeoViewer } from "@/server/geo/viewer";

export function useGeoViewer(): GeoViewer & { can: (permission: GeoPermission) => boolean } {
	const { geoViewer } = useRouteContext({ from: "/_authed/app/org/$org/geo" });
	const allowed = useCallback((permission: GeoPermission) => can(geoViewer.roles, permission), [geoViewer.roles]);
	return { ...geoViewer, can: allowed };
}
