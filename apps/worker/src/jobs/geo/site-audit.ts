import { GEO_QUEUE } from "@workspace/geo-domain";
import { getObjectStore } from "@workspace/geo-evidence";
import { processSiteAuditRun, sweepStaleSiteAuditRuns } from "@workspace/geo-site-ingestion/audit/store";
import type { SendJob, SiteJobDeps } from "@workspace/geo-site-ingestion/store";
import { db } from "@workspace/lib/db/db";
import { getBoss } from "../../boss";
import { defineGeoQueue, type GeoQueue } from "./queue";

const send: SendJob = (queue, data, options) => getBoss().send(queue, data, options ?? {});

function deps(): SiteJobDeps {
	return { db, objectStore: getObjectStore(), send, workerId: `worker-${process.pid}-audit` };
}

/**
 * audit.site has its own queue: it reads stored snapshots and makes at most a
 * handful of throttled requests, so it never competes with crawling or sampling.
 */
export const GEO_SITE_AUDIT_QUEUES: GeoQueue[] = [
	defineGeoQueue<{ organizationId: string; runId: string }>({
		name: GEO_QUEUE.siteAudit,
		options: { retryLimit: 0, expireInSeconds: 30 * 60 },
		work: { batchSize: 1, localConcurrency: 1 },
		handler: async ([job]) => processSiteAuditRun(deps(), job.data),
	}),
	defineGeoQueue<object>({
		name: "geo-site-audit-sweep",
		options: { retryLimit: 0, expireInSeconds: 5 * 60 },
		work: { batchSize: 1, localConcurrency: 1 },
		handler: async () => ({ requeued: await sweepStaleSiteAuditRuns(deps()) }),
		schedule: { cron: "*/15 * * * *" },
	}),
];
