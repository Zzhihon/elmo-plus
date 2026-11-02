import { geoSystemPrincipal } from "@workspace/geo-domain";
import { db } from "@workspace/lib/db/db";
import {
	detectAssertionConflicts,
	knowledgeOrganizationIds,
	sweepKnowledgeValidity,
} from "@workspace/lib/geo/knowledge";
import { defineGeoQueue, type GeoQueue } from "./queue";

/**
 * Conflicts between new website or document values and approved facts, and
 * approved facts that expired or lost their sources. Each organization runs in
 * its own transaction so one failure does not hold back the others.
 */
async function runKnowledgeMaintenance(): Promise<void> {
	const now = new Date();
	for (const organizationId of await knowledgeOrganizationIds(db)) {
		try {
			const result = await db.transaction(async (tx) => {
				const principal = geoSystemPrincipal(organizationId, "knowledge-maintenance", `knowledge-${now.getTime()}`);
				const conflicts = await detectAssertionConflicts(tx, principal);
				const validity = await sweepKnowledgeValidity(tx, organizationId, now);
				return { conflicts: conflicts.length, ...validity };
			});
			console.log(
				`[geo-knowledge] org=${organizationId} conflicts=${result.conflicts} expired=${result.EXPIRED} source_unavailable=${result.SOURCE_UNAVAILABLE} original_unavailable=${result.ORIGINAL_UNAVAILABLE}`,
			);
		} catch (error) {
			console.error(`[geo-knowledge] org=${organizationId} failed`, error);
		}
	}
}

export const GEO_KNOWLEDGE_QUEUES: GeoQueue[] = [
	defineGeoQueue<Record<string, never>>({
		name: "geo-knowledge-maintenance",
		options: { retryLimit: 1, retryDelay: 120, expireInSeconds: 30 * 60 },
		work: { batchSize: 1, localConcurrency: 1 },
		handler: async () => runKnowledgeMaintenance(),
		schedule: { cron: "*/10 * * * *" },
	}),
];
