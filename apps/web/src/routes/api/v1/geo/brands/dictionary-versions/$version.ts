import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { createGeoApiHandler, withGeoMethodGuard } from "@/lib/api/geo-handler";
import { getDictionaryVersionDetail } from "@/server/geo/profile-core";

export const Route = createFileRoute("/api/v1/geo/brands/dictionary-versions/$version")({
	server: {
		handlers: withGeoMethodGuard({
			GET: createGeoApiHandler({
				permission: "brand.read",
				params: z.object({ version: z.coerce.number().int().min(1) }),
				handle: async ({ principal, params }) => getDictionaryVersionDetail(principal, params.version),
			}),
		}),
	},
});
