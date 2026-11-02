import type { GeoAlertSeverity } from "@workspace/geo-domain";
import { and, eq, ne, sql } from "drizzle-orm";
import type { DbConnection } from "../db/db-connection";
import { geoAlerts } from "../db/schema-geo";

export interface RaiseGeoAlertInput {
	organizationId: string;
	kind: string;
	severity: GeoAlertSeverity;
	/** What makes two occurrences the same problem, e.g. `crawl-failing:<sourceId>`. */
	dedupeKey: string;
	context?: Record<string, unknown>;
}

export type GeoAlert = typeof geoAlerts.$inferSelect;

/** A recurrence of an unresolved alert bumps that row; after resolving, the same key opens a new one. */
export async function raiseGeoAlert(tx: DbConnection, input: RaiseGeoAlertInput): Promise<GeoAlert> {
	const [row] = await tx
		.insert(geoAlerts)
		.values({
			organizationId: input.organizationId,
			kind: input.kind,
			severity: input.severity,
			dedupeKey: input.dedupeKey,
			context: input.context ?? {},
		})
		.onConflictDoUpdate({
			target: [geoAlerts.organizationId, geoAlerts.dedupeKey],
			targetWhere: sql`${geoAlerts.status} <> 'RESOLVED'`,
			set: {
				severity: input.severity,
				context: input.context ?? {},
				lastSeen: sql`now()`,
				occurrences: sql`${geoAlerts.occurrences} + 1`,
			},
		})
		.returning();
	return row;
}

/** Answers how many alerts it closed, which is zero when the key was already clear. */
export async function resolveGeoAlert(
	tx: DbConnection,
	input: { organizationId: string; dedupeKey: string },
): Promise<number> {
	const rows = await tx
		.update(geoAlerts)
		.set({ status: "RESOLVED", resolvedAt: sql`now()` })
		.where(
			and(
				eq(geoAlerts.organizationId, input.organizationId),
				eq(geoAlerts.dedupeKey, input.dedupeKey),
				ne(geoAlerts.status, "RESOLVED"),
			),
		)
		.returning({ id: geoAlerts.id });
	return rows.length;
}
