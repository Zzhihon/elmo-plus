import { GEO_EVALUATE_OBSERVATION_QUEUE } from "@workspace/geo-domain";
import { type EvaluationJobData, evaluateObservation, sweepUnevaluated } from "./evaluation-run";
import { defineGeoQueue, type GeoQueue } from "./queue";

export const GEO_EVALUATION_QUEUES: GeoQueue[] = [
	defineGeoQueue<EvaluationJobData>({
		name: GEO_EVALUATE_OBSERVATION_QUEUE,
		options: { retryLimit: 3, retryDelay: 60, retryBackoff: true, expireInSeconds: 10 * 60 },
		work: { batchSize: 1, localConcurrency: 4 },
		handler: async ([job]) => {
			const { organizationId, observationId } = job.data;
			if (organizationId && observationId) return evaluateObservation(organizationId, observationId);
			return sweepUnevaluated();
		},
		schedule: { cron: "*/10 * * * *" },
	}),
];
