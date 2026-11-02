import { randomUUID } from "node:crypto";
import type { DbConnection } from "@workspace/lib/db/db-connection";
import { geoSiteHostThrottle } from "@workspace/lib/db/schema";
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { LIMITS } from "../crawl-policy";
import { defaultSleep, type SiteJobDeps } from "./deps";

const LEASE_MS = LIMITS.assetTimeoutMs + 60_000;
const POLL_MS = 500;
const MAX_WAIT_FOR_LEASE_MS = 3 * 60_000;

export type HostSlot =
	| { ok: true; release: (healthy: boolean) => Promise<HostHealth> }
	| { ok: false; reason: "BUSY" }
	| { ok: false; reason: "CIRCUIT_OPEN"; until: Date };

export interface HostHealth {
	consecutiveFailures: number;
	breakerOpenUntil: Date | null;
	/** True when this release is the one that tripped the breaker. */
	tripped: boolean;
}

function interval(ms: number) {
	return sql`now() + (${Math.max(Math.round(ms), 0)} * interval '1 millisecond')`;
}

/**
 * One request in flight per host, and a minimum gap between requests, across
 * every worker process: the lease and the next-allowed time live in one row
 * that all of them compete for, with the database clock as the only clock.
 */
export async function acquireHostSlot(
	deps: Pick<SiteJobDeps, "db" | "sleep" | "workerId">,
	host: string,
	minIntervalMs: number,
): Promise<HostSlot> {
	const { db } = deps;
	const sleep = deps.sleep ?? defaultSleep;
	const holder = `${deps.workerId ?? `pid-${process.pid}`}:${randomUUID()}`;
	const startedAt = Date.now();

	for (;;) {
		const [row] = await db
			.insert(geoSiteHostThrottle)
			.values({ host, holder, leaseUntil: sql`${interval(LEASE_MS)}`, nextAllowedAt: sql`now()` })
			.onConflictDoUpdate({
				target: geoSiteHostThrottle.host,
				set: { holder, leaseUntil: sql`${interval(LEASE_MS)}` },
				setWhere: or(isNull(geoSiteHostThrottle.leaseUntil), lt(geoSiteHostThrottle.leaseUntil, sql`now()`)),
			})
			.returning({
				nextAllowedAt: geoSiteHostThrottle.nextAllowedAt,
				breakerOpenUntil: geoSiteHostThrottle.breakerOpenUntil,
				dbNow: sql<Date>`now()`,
			});

		if (!row) {
			if (Date.now() - startedAt > MAX_WAIT_FOR_LEASE_MS) return { ok: false, reason: "BUSY" };
			await sleep(POLL_MS);
			continue;
		}

		const dbNow = new Date(row.dbNow).getTime();
		if (row.breakerOpenUntil && row.breakerOpenUntil.getTime() > dbNow) {
			await db
				.update(geoSiteHostThrottle)
				.set({ holder: null, leaseUntil: null })
				.where(and(eq(geoSiteHostThrottle.host, host), eq(geoSiteHostThrottle.holder, holder)));
			return { ok: false, reason: "CIRCUIT_OPEN", until: row.breakerOpenUntil };
		}

		const wait = row.nextAllowedAt.getTime() - dbNow;
		if (wait > 0) await sleep(wait);

		return {
			ok: true,
			release: async (healthy: boolean) => {
				const [after] = await db
					.update(geoSiteHostThrottle)
					.set({
						holder: null,
						leaseUntil: null,
						nextAllowedAt: sql`${interval(minIntervalMs)}`,
						consecutiveFailures: healthy ? 0 : sql`${geoSiteHostThrottle.consecutiveFailures} + 1`,
						lastSuccessAt: healthy ? sql`now()` : sql`${geoSiteHostThrottle.lastSuccessAt}`,
						breakerOpenUntil: healthy
							? null
							: sql`case when ${geoSiteHostThrottle.consecutiveFailures} + 1 >= ${LIMITS.breakerThreshold}
								then ${interval(LIMITS.breakerCooldownMs)} else ${geoSiteHostThrottle.breakerOpenUntil} end`,
					})
					.where(and(eq(geoSiteHostThrottle.host, host), eq(geoSiteHostThrottle.holder, holder)))
					.returning({
						consecutiveFailures: geoSiteHostThrottle.consecutiveFailures,
						breakerOpenUntil: geoSiteHostThrottle.breakerOpenUntil,
					});
				const failures = after?.consecutiveFailures ?? 0;
				return {
					consecutiveFailures: failures,
					breakerOpenUntil: after?.breakerOpenUntil ?? null,
					tripped: !healthy && failures === LIMITS.breakerThreshold,
				};
			},
		};
	}
}

export async function hostHealth(db: DbConnection, hosts: string[]) {
	if (hosts.length === 0) return [];
	return db
		.select()
		.from(geoSiteHostThrottle)
		.where(or(...hosts.map((host) => eq(geoSiteHostThrottle.host, host))));
}
