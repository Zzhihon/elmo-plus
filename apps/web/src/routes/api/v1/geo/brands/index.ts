import { createFileRoute } from "@tanstack/react-router";
import { GEO_ACTIVE_STATUSES, GEO_BRAND_KINDS } from "@workspace/geo-domain";
import { z } from "zod";
import { createGeoApiHandler, withGeoMethodGuard } from "@/lib/api/geo-handler";
import { brandInputSchema, createBrand, listBrands } from "@/server/geo/profile-core";

export const Route = createFileRoute("/api/v1/geo/brands/")({
	server: {
		handlers: withGeoMethodGuard({
			GET: createGeoApiHandler({
				permission: "brand.read",
				query: z.object({ kind: z.enum(GEO_BRAND_KINDS).optional(), status: z.enum(GEO_ACTIVE_STATUSES).optional() }),
				handle: async ({ principal, query }) => ({ data: await listBrands(principal, query) }),
			}),
			POST: createGeoApiHandler({
				permission: "brand.manage",
				body: brandInputSchema,
				status: 201,
				idempotent: true,
				handle: async ({ principal, body }) => createBrand(principal, body),
			}),
		}),
	},
});
