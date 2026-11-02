import { GEO_QUEUE } from "@workspace/geo-domain";
import { defineGeoQueue, type GeoQueue } from "./queue";
import { type CaptureJobData, processCaptureJob } from "./sampling-capture";
import { type DispatchJobData, dispatchBatch, sweepSampling } from "./sampling-dispatch";

export const GEO_SAMPLING_QUEUES: GeoQueue[] = [
	defineGeoQueue<DispatchJobData>({
		name: GEO_QUEUE.samplingDispatch,
		options: { retryLimit: 2, retryDelay: 30, retryBackoff: true, expireInSeconds: 10 * 60 },
		work: { batchSize: 1, localConcurrency: 1 },
		handler: async ([job]) => {
			const { organizationId, batchId } = job.data;
			if (organizationId && batchId) return { dispatched: await dispatchBatch(organizationId, batchId) };
			return sweepSampling();
		},
		schedule: { cron: "*/2 * * * *" },
	}),
	defineGeoQueue<CaptureJobData>({
		name: GEO_QUEUE.samplingCapture,
		// Business outcomes, retries included, are handled in the job; pg-boss only retries a crash.
		options: { retryLimit: 1, retryDelay: 60, expireInSeconds: 10 * 60 },
		work: { batchSize: 1, localConcurrency: 8 },
		handler: async ([job]) => processCaptureJob(job.data),
	}),
];
