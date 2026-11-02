import { createServerFn } from "@tanstack/react-start";
import type { GeoRole } from "@workspace/geo-domain";
import { z } from "zod";
import { resolveGeoSessionPrincipal } from "./context";

export interface GeoViewer {
	organizationId: string;
	actorId: string;
	roles: readonly GeoRole[];
}

export const getGeoViewerFn = createServerFn({ method: "GET" })
	.validator(z.object({ organizationId: z.string() }))
	.handler(async ({ data }): Promise<GeoViewer> => {
		const principal = await resolveGeoSessionPrincipal(data.organizationId);
		return {
			organizationId: principal.organizationId,
			actorId: principal.actorId,
			roles: principal.roles,
		};
	});
