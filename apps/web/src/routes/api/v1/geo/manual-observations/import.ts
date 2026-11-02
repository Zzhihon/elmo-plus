import { createFileRoute } from "@tanstack/react-router";
import { createGeoApiHandler, withGeoMethodGuard } from "@/lib/api/geo-handler";
import { importManualObservations, manualImportInputSchema } from "@/server/geo/observations-import-core";

export const Route = createFileRoute("/api/v1/geo/manual-observations/import")({
	server: {
		handlers: withGeoMethodGuard({
			POST: createGeoApiHandler({
				permission: "evidence.import",
				body: manualImportInputSchema,
				status: 201,
				idempotent: true,
				handle: async ({ body, principal, requestId }) => {
					const result = await importManualObservations(principal, body);
					if (!result.ok) {
						return Response.json(
							{ error: { code: result.code, message: result.message, request_id: requestId, details: result.errors } },
							{ status: result.code === "EVIDENCE_REQUIRED" ? 422 : 400 },
						);
					}
					const { ok: _ok, ...data } = result;
					return { data };
				},
			}),
		}),
	},
});
