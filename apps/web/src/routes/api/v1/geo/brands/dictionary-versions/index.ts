import { createFileRoute } from "@tanstack/react-router";
import { createGeoApiHandler, geoPage, geoPaging, withGeoMethodGuard } from "@/lib/api/geo-handler";
import { listDictionaryVersions } from "@/server/geo/profile-core";

export const Route = createFileRoute("/api/v1/geo/brands/dictionary-versions/")({
	server: {
		handlers: withGeoMethodGuard({
			GET: createGeoApiHandler({
				permission: "brand.read",
				handle: async ({ principal, request }) => {
					const paging = geoPaging(request);
					const { rows, total } = await listDictionaryVersions(principal, paging);
					return geoPage(rows, total, paging);
				},
			}),
		}),
	},
});
