import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireGeoServerFnPrincipal } from "./context";
import {
	getObservationReview,
	listReviewPool,
	observationReviewInputSchema,
	reviewPoolQuerySchema,
	submitObservationReview,
} from "./evaluation-core";

const org = z.object({ organizationId: z.string() });

export const getObservationReviewFn = createServerFn({ method: "GET" })
	.validator(org.extend({ observationId: z.guid() }))
	.handler(async ({ data }) => {
		const principal = await requireGeoServerFnPrincipal(data.organizationId, "observation.read");
		return getObservationReview(principal, data.observationId);
	});

export const submitObservationReviewFn = createServerFn({ method: "POST" })
	.validator(org.extend({ observationId: z.guid(), input: observationReviewInputSchema }))
	.handler(async ({ data }) => {
		const permission = data.input.type === "claim" ? "claim.review" : "observation.review";
		const principal = await requireGeoServerFnPrincipal(data.organizationId, permission);
		return submitObservationReview(principal, data.observationId, data.input);
	});

export const listReviewPoolFn = createServerFn({ method: "GET" })
	.validator(
		org.extend({
			page: z.number().int().min(1).default(1),
			limit: z.number().int().min(1).max(100).default(20),
			filters: reviewPoolQuerySchema.default({}),
		}),
	)
	.handler(async ({ data }) => {
		const principal = await requireGeoServerFnPrincipal(data.organizationId, "observation.read");
		const paging = { page: data.page, limit: data.limit, offset: (data.page - 1) * data.limit };
		const { rows, total } = await listReviewPool(principal, data.filters, paging);
		return { rows, total, page: data.page, totalPages: Math.ceil(total / data.limit) };
	});
