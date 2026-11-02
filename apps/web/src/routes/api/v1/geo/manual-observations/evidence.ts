import { createFileRoute } from "@tanstack/react-router";
import { GeoError } from "@workspace/geo-domain";
import { createGeoApiHandler, withGeoMethodGuard } from "@/lib/api/geo-handler";
import { uploadEvidenceFile } from "@/server/geo/observations-import-core";

/** Multipart upload of one screenshot or PDF; the returned `ref` goes into an import row's evidence location. */
export const Route = createFileRoute("/api/v1/geo/manual-observations/evidence")({
	server: {
		handlers: withGeoMethodGuard({
			POST: createGeoApiHandler({
				permission: "evidence.import",
				status: 201,
				handle: async ({ request, principal }) => {
					const form = await request.formData().catch(() => null);
					const file = form?.get("file");
					if (!(file instanceof File))
						throw new GeoError("VALIDATION_ERROR", "请以 multipart/form-data 上传 file 字段");
					return { data: await uploadEvidenceFile(principal, file) };
				},
			}),
		}),
	},
});
