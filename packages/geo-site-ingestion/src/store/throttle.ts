import { randomUUID } from "node:crypto";
import type { DbConnection } from "@workspace/lib/db/db-connection";
import { geoSiteHostThrottle } from "@workspace/lib/db/schema";
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { isRetryableResult, LIMITS } from "../crawl-policy";
import type { SafeFetchOptions, SafeFetchResult } from "../net/safe-fetch";
import { defaultSleep, type SiteJobDeps } from "./deps";

/** Long enough for the longest inline wait plus the slowest request, so a held lease cannot lapse mid-request. */
const LEASE_MS = LIMITS.maxInlineWaitMs + LIMITS.assetTimeoutMs + 30_000;
const POLL_MS = 500;
const MAX_WAIT_FOR_LEASE_MS = 3 * 60_000;

export type HostSlotRefusal =
	| { ok: false; reason: "BUSY" }
	| { ok: false; reason: "CIRCUIT_OPEN"; until: Date }
	/** The host may not be asked again before `until`, too far off to wait for here. */
	| { ok: false; reason: "DEFERRED"; until: Date };

export type HostSlot = { ok: true; release: (healthy: boolean) => Promise<HostHealth> } | HostSlotRefusal;

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
 * A short gap is waited out holding the lease; a long one hands the lease back
 * and refuses, so no lease ever outlives its holder's sleep.
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

		const giveBack = () =>
			db
				.update(geoSiteHostThrottle)
				.set({ holder: null, leaseUntil: null })
				.where(and(eq(geoSiteHostThrottle.host, host), eq(geoSiteHostThrottle.holder, holder)));

		const dbNow = new Date(row.dbNow).getTime();
		if (row.breakerOpenUntil && row.breakerOpenUntil.getTime() > dbNow) {
			await giveBack();
			return { ok: false, reason: "CIRCUIT_OPEN", until: row.breakerOpenUntil };
		}

		const wait = row.nextAllowedAt.getTime() - dbNow;
		if (wait > LIMITS.maxInlineWaitMs) {
			await giveBack();
			return { ok: false, reason: "DEFERRED", until: row.nextAllowedAt };
		}
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

export type PacedFetch =
	| { refusal: HostSlotRefusal }
	/** `health` is null when a redirect was vetoed, since no request was left to account for. */
	| { refusal: null; result: SafeFetchResult; host: string; health: HostHealth | null };

/**
 * A guarded fetch where every hop, redirects included, takes its own turn on the
 * slot of the host it is about to ask. `vetRedirect` can turn a hop down by
 * returning the reason; it runs with no slot held, so it may fetch for itself.
 */
export async function fetchInHostSlots(
	deps: Pick<SiteJobDeps, "db" | "sleep" | "workerId">,
	input: {
		url: string;
		options: Omit<SafeFetchOptions, "beforeRedirect">;
		intervalFor: (url: string) => number;
		fetch: (url: string, options: SafeFetchOptions) => Promise<SafeFetchResult>;
		vetRedirect?: (target: string) => Promise<string | null>;
	},
): Promise<PacedFetch> {
	const first = await acquireHostSlot(deps, new URL(input.url).hostname, input.intervalFor(input.url));
	if (!first.ok) return { refusal: first };
	let held: Extract<HostSlot, { ok: true }> | null = first;
	let host = new URL(input.url).hostname;
	let refusal: HostSlotRefusal | null = null;

	let result: SafeFetchResult;
	try {
		result = await input.fetch(input.url, {
			...input.options,
			beforeRedirect: async (target) => {
				await held?.release(true);
				held = null;
				const veto = await input.vetRedirect?.(target);
				if (veto) return { follow: false, detail: veto };
				host = new URL(target).hostname;
				const next = await acquireHostSlot(deps, host, input.intervalFor(target));
				if (!next.ok) {
					refusal = next;
					return { follow: false, detail: `host slot refused: ${next.reason}` };
				}
				held = next;
				return { follow: true };
			},
		});
	} catch (error) {
		await held?.release(false);
		throw error;
	}
	if (refusal) return { refusal };
	const health = held ? await (held as Extract<HostSlot, { ok: true }>).release(!isRetryableResult(result)) : null;
	return { refusal: null, result, host, health };
}

export async function hostHealth(db: DbConnection, hosts: string[]) {
	if (hosts.length === 0) return [];
	return db
		.select()
		.from(geoSiteHostThrottle)
		.where(or(...hosts.map((host) => eq(geoSiteHostThrottle.host, host))));
}
