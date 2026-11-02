/**
 * /api/v1/geo/knowledge-claims — keyword and structured search over claims.
 *
 * Every row carries `evidenceClass`: APPROVED_FACT for reviewed facts in date,
 * UNREVIEWED for anything a page or document says that nobody has confirmed.
 * Pass `verified=true` or `verified=false` to get one class only.
 */
import { createFileRoute } from "@tanstack/react-router";
import { createGeoApiHandler, geoPage, geoPaging, withGeoMethodGuard } from "@/lib/api/geo-handler";
import { claimListQuerySchema, searchClaims } from "@/server/geo/knowledge-core";

export const Route = createFileRoute("/api/v1/geo/knowledge-claims/")({
	server: {
		handlers: withGeoMethodGuard({
			GET: createGeoApiHandler({
				permission: "knowledge.read",
				query: claimListQuerySchema,
				handle: async ({ request, principal, query }) => {
					const paging = geoPaging(request);
					const { rows, total } = await searchClaims(principal, query, paging);
					return geoPage(rows, total, paging);
				},
			}),
		}),
	},
});
