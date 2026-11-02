import type { GeoQueueName } from "@workspace/geo-domain";
import type { Job, QueueOptions, ScheduleOptions, WorkOptions } from "pg-boss";

export type GeoJobHandler<T> = (jobs: Job<T>[]) => Promise<unknown>;

export interface GeoQueueSchedule {
	cron: string;
	data?: object;
	/** Defaults to UTC with the queue's name as the singleton key. */
	options?: ScheduleOptions;
}

/** One kind of job, with its own limits, so a slow source site cannot hold up sampling. */
export interface GeoQueue {
	name: GeoQueueName;
	options: QueueOptions;
	work: WorkOptions;
	handler: GeoJobHandler<unknown>;
	schedule?: GeoQueueSchedule;
}

/** Keeps `T` checked between the handler and the jobs it receives, then erases it for the shared registry. */
export function defineGeoQueue<T extends object>(
	queue: Omit<GeoQueue, "handler"> & { handler: GeoJobHandler<T> },
): GeoQueue {
	return queue as GeoQueue;
}
