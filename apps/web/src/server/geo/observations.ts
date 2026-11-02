import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireGeoServerFnPrincipal } from "./context";
import { getObservation, listObservations, observationListQuerySchema } from "./observations-core";
import { importManualObservations, manualImportInputSchema } from "./observations-import-core";

const org = z.object({ organizationId: z.string() });

export const listObservationsFn = createServerFn({ method: "GET" })
	.validator(
		org.extend({
			page: z.number().int().min(1).default(1),
			limit: z.number().int().min(1).max(100).default(20),
			filters: observationListQuerySchema.default({}),
		}),
	)
	.handler(async ({ data }) => {
		const principal = await requireGeoServerFnPrincipal(data.organizationId, "observation.read");
		const paging = { page: data.page, limit: data.limit, offset: (data.page - 1) * data.limit };
		const { rows, total } = await listObservations(principal, data.filters, paging);
		return { rows, total, page: data.page, totalPages: Math.ceil(total / data.limit) };
	});

export const getObservationFn = createServerFn({ method: "GET" })
	.validator(org.extend({ observationId: z.guid() }))
	.handler(async ({ data }) => {
		const principal = await requireGeoServerFnPrincipal(data.organizationId, "observation.read");
		return getObservation(principal, data.observationId);
	});

/** Returns a rejected import as data, so the form can show every row's problem rather than one thrown message. */
export const importManualObservationsFn = createServerFn({ method: "POST" })
	.validator(org.extend({ input: manualImportInputSchema }))
	.handler(async ({ data }) => {
		const principal = await requireGeoServerFnPrincipal(data.organizationId, "evidence.import");
		return importManualObservations(principal, data.input);
	});
