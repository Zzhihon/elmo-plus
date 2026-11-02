import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { createGeoApiHandler, withGeoMethodGuard } from "@/lib/api/geo-handler";
import { brandPatchSchema, getBrand, updateBrand } from "@/server/geo/profile-core";

const params = z.object({ id: z.uuid() });

export const Route = createFileRoute("/api/v1/geo/brands/$id/")({
	server: {
		handlers: withGeoMethodGuard({
			GET: createGeoApiHandler({
				permission: "brand.read",
				params,
				handle: async ({ principal, params }) => getBrand(principal, params.id),
			}),
			PATCH: createGeoApiHandler({
				permission: "brand.manage",
				params,
				body: brandPatchSchema.refine((patch) => Object.keys(patch).length > 0, "至少需要修改一个字段"),
				idempotent: true,
				handle: async ({ principal, params, body }) => updateBrand(principal, params.id, body),
			}),
		}),
	},
});
