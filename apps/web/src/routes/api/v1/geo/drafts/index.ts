/**
 * /api/v1/geo/drafts — AI-assisted content drafts.
 *
 * GET   list (state, kind, taskId)
 * POST  create from approved public facts, by model (needs the organization's
 *       model-use approval) or by hand; returns the deterministic fact check
 */
import { createFileRoute } from "@tanstack/react-router";
import { createGeoApiHandler, geoPage, geoPaging, withGeoMethodGuard } from "@/lib/api/geo-handler";
import { createDraft, createDraftSchema, draftFiltersSchema, listDrafts } from "@/server/geo/drafts-core";

export const Route = createFileRoute("/api/v1/geo/drafts/")({
	server: {
		handlers: withGeoMethodGuard({
			GET: createGeoApiHandler({
				permission: "content.read",
				query: draftFiltersSchema,
				handle: async ({ request, principal, query }) => {
					const paging = geoPaging(request);
					const { rows, total } = await listDrafts(principal, query, paging);
					return geoPage(rows, total, paging);
				},
			}),
			POST: createGeoApiHandler({
				permission: "content.write",
				body: createDraftSchema,
				status: 201,
				idempotent: true,
				handle: async ({ principal, body }) => ({ data: await createDraft(principal, body) }),
			}),
		}),
	},
});
