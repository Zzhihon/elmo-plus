import { createFileRoute } from "@tanstack/react-router";
import { GeoError } from "@workspace/geo-domain";
import { z } from "zod";
import { createGeoApiHandler, withGeoMethodGuard } from "@/lib/api/geo-handler";
import { getSitePage, getSnapshotDownload } from "@/server/geo/site-core";

export const Route = createFileRoute("/api/v1/geo/site-pages/$pageId/versions/$versionId/snapshot")({
	server: {
		handlers: withGeoMethodGuard({
			GET: createGeoApiHandler({
				permission: "site.read_snapshot",
				params: z.object({ pageId: z.string().uuid(), versionId: z.string().uuid() }),
				handle: async ({ principal, params }) => {
					const { versions } = await getSitePage(principal, params.pageId);
					if (!versions.some((version) => version.id === params.versionId)) {
						throw new GeoError("NOT_FOUND", "页面版本不存在");
					}
					return getSnapshotDownload(principal, params.versionId);
				},
			}),
		}),
	},
});
