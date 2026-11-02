import { GEO_OBSERVATION_STATUSES, GEO_PLATFORMS, GEO_SURFACE_MODES } from "@workspace/geo-domain";
import { z } from "zod";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The evidence list's filters live in the URL, so a chart or report can link straight to the samples behind a number. */
export const observationSearchSchema = z.object({
	page: z.coerce.number().int().min(1).optional().catch(undefined),
	q: z.string().max(200).optional().catch(undefined),
	promptId: z.guid().optional().catch(undefined),
	promptSetId: z.guid().optional().catch(undefined),
	targetId: z.guid().optional().catch(undefined),
	batchId: z.guid().optional().catch(undefined),
	platform: z.enum(GEO_PLATFORMS).optional().catch(undefined),
	surfaceMode: z.enum(GEO_SURFACE_MODES).optional().catch(undefined),
	status: z.enum(GEO_OBSERVATION_STATUSES).optional().catch(undefined),
	from: z.string().regex(DATE).optional().catch(undefined),
	to: z.string().regex(DATE).optional().catch(undefined),
});
export type ObservationSearch = z.infer<typeof observationSearchSchema>;
