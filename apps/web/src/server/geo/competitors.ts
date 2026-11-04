import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
	acceptCompetitorCandidate,
	discoveryInputSchema,
	dismissCompetitorCandidate,
	listCompetitors,
	startCompetitorDiscovery,
} from "./competitors-core";
import { requireGeoServerFnPrincipal } from "./context";

const org = z.object({ organizationId: z.string() });
const candidate = org.extend({ candidateId: z.guid() });

export const listCompetitorsFn = createServerFn({ method: "GET" })
	.validator(org)
	.handler(async ({ data }) =>
		listCompetitors(await requireGeoServerFnPrincipal(data.organizationId, "competitor.read")),
	);

export const startCompetitorDiscoveryFn = createServerFn({ method: "POST" })
	.validator(org.extend(discoveryInputSchema.shape))
	.handler(async ({ data }) => {
		const principal = await requireGeoServerFnPrincipal(data.organizationId, "competitor.discover");
		return startCompetitorDiscovery(principal, { sampleFirst: data.sampleFirst });
	});

export const acceptCompetitorCandidateFn = createServerFn({ method: "POST" })
	.validator(candidate)
	.handler(async ({ data }) => {
		const principal = await requireGeoServerFnPrincipal(data.organizationId, "competitor.decide");
		return acceptCompetitorCandidate(principal, data.candidateId);
	});

export const dismissCompetitorCandidateFn = createServerFn({ method: "POST" })
	.validator(candidate)
	.handler(async ({ data }) => {
		const principal = await requireGeoServerFnPrincipal(data.organizationId, "competitor.decide");
		await dismissCompetitorCandidate(principal, data.candidateId);
		return { ok: true };
	});
