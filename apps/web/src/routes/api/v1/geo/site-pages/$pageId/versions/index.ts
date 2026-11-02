import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { createGeoApiHandler, withGeoMethodGuard } from "@/lib/api/geo-handler";
import { getPageVersion, listPageVersions } from "@/server/geo/site-core";

const query = z
	.object({ versionId: z.string().uuid().optional(), compareTo: z.string().uuid().optional() })
	.passthrough();

export const Route = createFileRoute("/api/v1/geo/site-pages/$pageId/versions/")({
	server: {
		handlers: withGeoMethodGuard({
			GET: createGeoApiHandler({
				permission: "site.read",
				params: z.object({ pageId: z.string().uuid() }),
				query,
				handle: async ({ principal, params, query }) => {
					const versions = await listPageVersions(principal, params.pageId);
					const selectedId = query.versionId ?? versions[0]?.id;
					const selected = selectedId
						? await getPageVersion(principal, params.pageId, selectedId, query.compareTo)
						: null;
					return {
						data: versions.map((version) => ({
							...version,
							snapshotUrl: `/api/v1/geo/site-pages/${params.pageId}/versions/${version.id}/snapshot`,
						})),
						selected,
					};
				},
			}),
		}),
	},
});
