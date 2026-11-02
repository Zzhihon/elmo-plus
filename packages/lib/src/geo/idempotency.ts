import { and, eq, lt, sql } from "drizzle-orm";
import type { DbConnection } from "../db/db-connection";
import { geoIdempotencyKeys } from "../db/schema-geo";

const KEY_TTL_HOURS = 24;
/** Long enough to outlast any request; after this a claim is taken to have died with its process. */
const IN_FLIGHT_TTL_MINUTES = 10;

export interface GeoIdempotencyScope {
	organizationId: string;
	key: string;
	route: string;
}

export type GeoIdempotencyClaim =
	| { kind: "claimed" }
	| { kind: "replay"; status: number; body: unknown }
	| { kind: "in_flight" }
	| { kind: "mismatch" };

function scopeCondition(scope: GeoIdempotencyScope) {
	return and(
		eq(geoIdempotencyKeys.organizationId, scope.organizationId),
		eq(geoIdempotencyKeys.key, scope.key),
		eq(geoIdempotencyKeys.route, scope.route),
	);
}

/** The insert is the lock: of two concurrent requests with one key, exactly one gets a row back. */
export async function claimGeoIdempotencyKey(
	db: DbConnection,
	scope: GeoIdempotencyScope & { requestHash: string },
): Promise<GeoIdempotencyClaim> {
	const expired = sql`${geoIdempotencyKeys.createdAt} < now() - make_interval(hours => ${KEY_TTL_HOURS})
		or (${geoIdempotencyKeys.responseStatus} is null
			and ${geoIdempotencyKeys.createdAt} < now() - make_interval(mins => ${IN_FLIGHT_TTL_MINUTES}))`;

	const claimed = await db
		.insert(geoIdempotencyKeys)
		.values({
			organizationId: scope.organizationId,
			key: scope.key,
			route: scope.route,
			requestHash: scope.requestHash,
		})
		.onConflictDoUpdate({
			target: [geoIdempotencyKeys.organizationId, geoIdempotencyKeys.key, geoIdempotencyKeys.route],
			setWhere: expired,
			set: {
				requestHash: scope.requestHash,
				responseStatus: null,
				responseBody: null,
				createdAt: sql`now()`,
			},
		})
		.returning({ key: geoIdempotencyKeys.key });
	if (claimed.length > 0) return { kind: "claimed" };

	const [existing] = await db
		.select({
			requestHash: geoIdempotencyKeys.requestHash,
			responseStatus: geoIdempotencyKeys.responseStatus,
			responseBody: geoIdempotencyKeys.responseBody,
		})
		.from(geoIdempotencyKeys)
		.where(scopeCondition(scope))
		.limit(1);

	if (!existing) return { kind: "in_flight" };
	if (existing.requestHash !== scope.requestHash) return { kind: "mismatch" };
	if (existing.responseStatus === null) return { kind: "in_flight" };
	return { kind: "replay", status: existing.responseStatus, body: existing.responseBody };
}

export async function completeGeoIdempotencyKey(
	db: DbConnection,
	scope: GeoIdempotencyScope & { status: number; body: unknown },
): Promise<void> {
	await db
		.update(geoIdempotencyKeys)
		.set({ responseStatus: scope.status, responseBody: scope.body })
		.where(scopeCondition(scope));
}

/** A failed attempt had no effect, so the caller may retry it under the same key. */
export async function releaseGeoIdempotencyKey(db: DbConnection, scope: GeoIdempotencyScope): Promise<void> {
	await db.delete(geoIdempotencyKeys).where(scopeCondition(scope));
}

export async function purgeExpiredGeoIdempotencyKeys(db: DbConnection): Promise<number> {
	const cutoff = new Date(Date.now() - KEY_TTL_HOURS * 60 * 60 * 1000);
	const rows = await db
		.delete(geoIdempotencyKeys)
		.where(lt(geoIdempotencyKeys.createdAt, cutoff))
		.returning({ key: geoIdempotencyKeys.key });
	return rows.length;
}
