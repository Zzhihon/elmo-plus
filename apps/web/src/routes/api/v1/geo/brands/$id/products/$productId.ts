import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { createGeoApiHandler, withGeoMethodGuard } from "@/lib/api/geo-handler";
import { productPatchSchema, updateProduct } from "@/server/geo/profile-core";

export const Route = createFileRoute("/api/v1/geo/brands/$id/products/$productId")({
	server: {
		handlers: withGeoMethodGuard({
			PATCH: createGeoApiHandler({
				permission: "brand.manage",
				params: z.object({ id: z.uuid(), productId: z.uuid() }),
				body: productPatchSchema.refine((patch) => Object.keys(patch).length > 0, "至少需要修改一个字段"),
				idempotent: true,
				handle: async ({ principal, params, body }) => updateProduct(principal, params.id, params.productId, body),
			}),
		}),
	},
});
