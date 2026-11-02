import { isGeoWorkspaceEnabled } from "@workspace/config/geo";
import { GeoError, type GeoQueueName } from "@workspace/geo-domain";
import type { SendOptions } from "pg-boss";
import { getBoss } from "@/lib/boss-client";

/**
 * Sends after the caller's transaction commits, so a job can never point at a row
 * that rolled back. The worker owns the queues and their limits, which is why a
 * queue the worker has not created yet is an error here rather than created blind.
 *
 * Null when `singletonKey` matched a job already queued.
 */
export async function enqueueGeoJob(queue: GeoQueueName, data: object, options?: SendOptions): Promise<string | null> {
	if (!isGeoWorkspaceEnabled()) throw new GeoError("NOT_FOUND", "GEO 工作台未启用");
	const boss = await getBoss();
	try {
		return await boss.send(queue, data, options ?? {});
	} catch (error) {
		if (error instanceof Error && error.message.includes("does not exist")) {
			throw new GeoError("TARGET_UNAVAILABLE", "后台队列尚未就绪，请确认 worker 已启动", { cause: error });
		}
		throw error;
	}
}
