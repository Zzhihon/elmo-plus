import { GEO_QUEUE } from "@workspace/geo-domain";
import { getObjectStore } from "@workspace/geo-evidence";
import {
	normalizeSiteVersion,
	parseCrawlItem,
	processCrawlRun,
	reparseSitePage,
	type SendJob,
	type SiteJobDeps,
	tickSiteSchedules,
} from "@workspace/geo-site-ingestion/store";
import { db } from "@workspace/lib/db/db";
import { getBoss } from "../../boss";
import { defineGeoQueue, type GeoQueue } from "./queue";

const send: SendJob = (queue, data, options) => getBoss().send(queue, data, options ?? {});

function deps(): SiteJobDeps {
	return { db, objectStore: getObjectStore(), send, workerId: `worker-${process.pid}` };
}

type ParseJob =
	| { organizationId: string; itemId: string }
	| { organizationId: string; reparse: { pageId: string; versionId?: string | null; profileVersion?: number | null } };

/**
 * Crawling, parsing and normalizing each have their own queue and concurrency,
 * apart from sampling, so a slow or failing site only ever backs up its own
 * queue. Politeness per host is enforced in the database, not by these limits.
 */
export const GEO_SITE_QUEUES: GeoQueue[] = [
	defineGeoQueue<object>({
		name: GEO_QUEUE.siteSchedule,
		options: { retryLimit: 0, expireInSeconds: 10 * 60 },
		work: { batchSize: 1, localConcurrency: 1 },
		handler: async () => tickSiteSchedules(deps()),
		schedule: { cron: "*/10 * * * *" },
	}),
	defineGeoQueue<{ organizationId: string; runId: string }>({
		name: GEO_QUEUE.siteCrawl,
		options: { retryLimit: 2, retryDelay: 60, retryBackoff: true, expireInSeconds: 20 * 60 },
		work: { batchSize: 1, localConcurrency: 2 },
		handler: async ([job]) => processCrawlRun(deps(), job.data),
	}),
	defineGeoQueue<ParseJob>({
		name: GEO_QUEUE.siteParse,
		options: { retryLimit: 3, retryDelay: 30, retryBackoff: true, expireInSeconds: 5 * 60 },
		work: { batchSize: 1, localConcurrency: 2 },
		handler: async ([job]) => {
			if ("reparse" in job.data) {
				const { version, created } = await reparseSitePage(deps(), {
					organizationId: job.data.organizationId,
					...job.data.reparse,
				});
				return { versionId: version.id, created };
			}
			const version = await parseCrawlItem(deps(), job.data);
			return { versionId: version?.id ?? null };
		},
	}),
	defineGeoQueue<{ organizationId: string; versionId: string }>({
		name: GEO_QUEUE.siteNormalize,
		options: { retryLimit: 3, retryDelay: 30, retryBackoff: true, expireInSeconds: 5 * 60 },
		work: { batchSize: 1, localConcurrency: 2 },
		handler: async ([job]) => {
			const result = await normalizeSiteVersion(deps(), job.data);
			return { entities: result?.entities.length ?? 0, assertions: result?.assertions.length ?? 0 };
		},
	}),
];
