import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { createGeoApiHandler, withGeoMethodGuard } from "@/lib/api/geo-handler";
import { getClaimDetail } from "@/server/geo/knowledge-core";

export const Route = createFileRoute("/api/v1/geo/knowledge-claims/$claimId/")({
	server: {
		handlers: withGeoMethodGuard({
			GET: createGeoApiHandler({
				permission: "knowledge.read",
				params: z.object({ claimId: z.string().uuid() }),
				handle: async ({ principal, params }) => ({ data: await getClaimDetail(principal, params.claimId) }),
			}),
		}),
	},
});
