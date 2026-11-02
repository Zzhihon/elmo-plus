import type { GeoQueueName } from "@workspace/geo-domain";
import type { ObjectStore } from "@workspace/geo-evidence";
import type { DbConnection } from "@workspace/lib/db/db-connection";
import type { SafeFetchOptions, SafeFetchResult } from "../net/safe-fetch";

export type SendJob = (
	queue: GeoQueueName,
	data: object,
	options?: { singletonKey?: string; startAfter?: Date | number },
) => Promise<string | null>;

/** Everything a site job touches from outside, so the same code runs in the worker and in tests. */
export interface SiteJobDeps {
	db: DbConnection;
	objectStore: ObjectStore;
	send: SendJob;
	fetch?: (url: string, options: SafeFetchOptions) => Promise<SafeFetchResult>;
	now?: () => Date;
	sleep?: (ms: number) => Promise<void>;
	/** Identifies this process in host leases. */
	workerId?: string;
}

export function nowOf(deps: Pick<SiteJobDeps, "now">): Date {
	return deps.now ? deps.now() : new Date();
}

export const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
