import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireGeoServerFnPrincipal } from "./context";
import {
	batchComparisonQuerySchema,
	compareBatchesFor,
	getInsights,
	getOverview,
	metricQuerySchema,
} from "./metrics-core";

const org = z.object({ organizationId: z.string() });

export const getInsightsFn = createServerFn({ method: "GET" })
	.validator(org.extend({ query: metricQuerySchema.default({}) }))
	.handler(async ({ data }) => {
		const principal = await requireGeoServerFnPrincipal(data.organizationId, "metric.read");
		return getInsights(principal, data.query);
	});

export const getOverviewFn = createServerFn({ method: "GET" })
	.validator(org)
	.handler(async ({ data }) => {
		const principal = await requireGeoServerFnPrincipal(data.organizationId, "metric.read");
		return getOverview(principal);
	});

/** For the task retest view: the two linked batches compared under the same conditions. */
export const compareBatchesFn = createServerFn({ method: "GET" })
	.validator(org.extend({ query: batchComparisonQuerySchema }))
	.handler(async ({ data }) => {
		const principal = await requireGeoServerFnPrincipal(data.organizationId, "metric.read");
		return compareBatchesFor(principal, data.query);
	});
