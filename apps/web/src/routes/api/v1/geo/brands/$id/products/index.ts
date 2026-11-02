import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { createGeoApiHandler, withGeoMethodGuard } from "@/lib/api/geo-handler";
import { createProduct, productInputSchema } from "@/server/geo/profile-core";

export const Route = createFileRoute("/api/v1/geo/brands/$id/products/")({
	server: {
		handlers: withGeoMethodGuard({
			POST: createGeoApiHandler({
				permission: "brand.manage",
				params: z.object({ id: z.uuid() }),
				body: productInputSchema,
				status: 201,
				idempotent: true,
				handle: async ({ principal, params, body }) => createProduct(principal, params.id, body),
			}),
		}),
	},
});
