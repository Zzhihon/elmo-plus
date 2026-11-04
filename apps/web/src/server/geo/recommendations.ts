import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireGeoServerFnPrincipal } from "./context";
import {
	convertRecommendationToTask,
	dismissRecommendation,
	getCompetitorComparison,
	listRecommendations,
	recommendationDecisionSchema,
	regenerateRecommendations,
	restoreRecommendation,
} from "./recommendations-core";

const org = z.object({ organizationId: z.string().min(1) });

export const listRecommendationsFn = createServerFn({ method: "GET" })
	.validator(org)
	.handler(async ({ data }) =>
		listRecommendations(await requireGeoServerFnPrincipal(data.organizationId, "recommendation.read")),
	);

export const getCompetitorComparisonFn = createServerFn({ method: "GET" })
	.validator(org)
	.handler(async ({ data }) =>
		getCompetitorComparison(await requireGeoServerFnPrincipal(data.organizationId, "recommendation.read")),
	);

export const regenerateRecommendationsFn = createServerFn({ method: "POST" })
	.validator(org)
	.handler(async ({ data }) =>
		regenerateRecommendations(await requireGeoServerFnPrincipal(data.organizationId, "recommendation.generate")),
	);

export const dismissRecommendationFn = createServerFn({ method: "POST" })
	.validator(org.extend({ input: recommendationDecisionSchema }))
	.handler(async ({ data }) =>
		dismissRecommendation(await requireGeoServerFnPrincipal(data.organizationId, "recommendation.triage"), data.input),
	);

export const restoreRecommendationFn = createServerFn({ method: "POST" })
	.validator(org.extend({ input: recommendationDecisionSchema }))
	.handler(async ({ data }) =>
		restoreRecommendation(await requireGeoServerFnPrincipal(data.organizationId, "recommendation.triage"), data.input),
	);

export const convertRecommendationFn = createServerFn({ method: "POST" })
	.validator(org.extend({ input: recommendationDecisionSchema }))
	.handler(async ({ data }) =>
		convertRecommendationToTask(await requireGeoServerFnPrincipal(data.organizationId, "task.create"), data.input),
	);
