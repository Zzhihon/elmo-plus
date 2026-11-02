import { GEO_QUEUE } from "@workspace/geo-domain";
import { defineGeoQueue, type GeoQueue } from "./queue";
import { generateReport, type ReportJobData, reportTick } from "./reports-generate";

export const GEO_REPORTS_QUEUES: GeoQueue[] = [
	defineGeoQueue<ReportJobData>({
		name: GEO_QUEUE.reportGenerate,
		options: { retryLimit: 2, retryDelay: 120, retryBackoff: true, expireInSeconds: 20 * 60 },
		work: { batchSize: 1, localConcurrency: 1 },
		handler: async ([job]) => {
			const { organizationId, reportId } = job.data;
			if (organizationId && reportId) return generateReport(organizationId, reportId);
			return reportTick();
		},
		schedule: { cron: "*/15 * * * *" },
	}),
];
