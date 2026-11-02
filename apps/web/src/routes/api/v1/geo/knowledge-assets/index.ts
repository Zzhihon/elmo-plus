/**
 * /api/v1/geo/knowledge-assets — customer originals.
 *
 * GET   list with approval and scan status (q, assetType, approvalStatus)
 * POST  multipart upload: `file` plus title, assetType, confidentiality, publicationScope,
 *       validUntil, description, sourceUri. The same bytes uploaded again return the existing asset with 200.
 */
import { createFileRoute } from "@tanstack/react-router";
import { createGeoApiHandler, geoPage, geoPaging, withGeoMethodGuard } from "@/lib/api/geo-handler";
import {
	assetFiltersSchema,
	listKnowledgeAssets,
	readAssetUpload,
	uploadKnowledgeAsset,
} from "@/server/geo/knowledge-assets-core";

export const Route = createFileRoute("/api/v1/geo/knowledge-assets/")({
	server: {
		handlers: withGeoMethodGuard({
			GET: createGeoApiHandler({
				permission: "knowledge.read",
				query: assetFiltersSchema,
				handle: async ({ request, principal, query }) => {
					const paging = geoPaging(request);
					const { rows, total } = await listKnowledgeAssets(principal, query, paging);
					return geoPage(rows, total, paging);
				},
			}),
			POST: createGeoApiHandler({
				permission: "knowledge.write",
				handle: async ({ principal, request }) => {
					const { file, metadata } = await readAssetUpload(request);
					const { asset, created } = await uploadKnowledgeAsset(principal, file, metadata);
					return Response.json({ data: asset, created }, { status: created ? 201 : 200 });
				},
			}),
		}),
	},
});
