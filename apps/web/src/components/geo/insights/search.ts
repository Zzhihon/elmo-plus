import { GEO_PLATFORMS, GEO_SURFACE_MODES } from "@workspace/geo-domain";
import { z } from "zod";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export const INSIGHT_TABS = ["platforms", "questions", "competitors", "citations", "errors", "review"] as const;
export type InsightTab = (typeof INSIGHT_TABS)[number];

/** The comparison conditions live in the URL, so a view can be shared and reproduced exactly. */
export const insightSearchSchema = z.object({
	tab: z.enum(INSIGHT_TABS).optional().catch(undefined),
	from: z.string().regex(DATE).optional().catch(undefined),
	to: z.string().regex(DATE).optional().catch(undefined),
	promptSetId: z.guid().optional().catch(undefined),
	platform: z.enum(GEO_PLATFORMS).optional().catch(undefined),
	surfaceMode: z.enum(GEO_SURFACE_MODES).optional().catch(undefined),
	page: z.coerce.number().int().min(1).optional().catch(undefined),
});
export type InsightSearch = z.infer<typeof insightSearchSchema>;

export const insightKeys = {
	all: (organizationId: string) => ["geo", "insights", organizationId] as const,
	insights: (organizationId: string, query: object) => [...insightKeys.all(organizationId), "metrics", query] as const,
	claims: (organizationId: string, query: object) => [...insightKeys.all(organizationId), "claims", query] as const,
	overview: (organizationId: string) => [...insightKeys.all(organizationId), "overview"] as const,
	reviewPool: (organizationId: string, filters: object, page: number) =>
		[...insightKeys.all(organizationId), "review-pool", filters, page] as const,
	review: (organizationId: string, observationId: string) =>
		[...insightKeys.all(organizationId), "review", observationId] as const,
	comparison: (organizationId: string, query: object) =>
		[...insightKeys.all(organizationId), "comparison", query] as const,
};
