import {
	GEO_ADMIN_REQUEST_OVERDUE_HOURS,
	GEO_BACKUP_STALE_HOURS,
	GEO_TASK_REVIEW_OVERDUE_HOURS,
	geoSystemPrincipal,
} from "@workspace/geo-domain";
import { and, asc, desc, eq, gt, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import type { db as Database } from "../db/db";
import type { DbConnection } from "../db/db-connection";
import {
	geoAdminRequests,
	geoAlerts,
	geoBackupRuns,
	geoOptimizationTasks,
	geoOrgSettings,
	geoSamplingBatches,
	geoTaskEvents,
} from "../db/schema-geo";
import { raiseGeoAlert, resolveGeoAlert } from "./alerts";
import { writeGeoAudit } from "./audit";

type Db = typeof Database;

const HOUR_MS = 60 * 60 * 1000;
const REVIEW_STATES = ["PENDING_TECH_REVIEW", "PENDING_MARKETING_REVIEW"] as const;

/** Organizations that use the workspace at all; maintenance leaves every other one alone. */
export async function geoActiveOrganizationIds(db: DbConnection): Promise<string[]> {
	const result = await db.execute(sql`
		select organization_id from geo_org_settings
		union select organization_id from geo_role_assignments
		union select organization_id from geo_optimization_tasks
		union select organization_id from geo_sampling_targets
	`);
	return (result.rows as { organization_id: string }[]).map((row) => row.organization_id);
}

/** Closes alerts under `prefix` whose problem is gone. */
async function resolveStale(db: DbConnection, organizationId: string, prefix: string, current: Set<string>) {
	const open = await db
		.select({ dedupeKey: geoAlerts.dedupeKey })
		.from(geoAlerts)
		.where(
			and(
				eq(geoAlerts.organizationId, organizationId),
				ne(geoAlerts.status, "RESOLVED"),
				sql`left(${geoAlerts.dedupeKey}, ${prefix.length}) = ${prefix}`,
			),
		);
	for (const { dedupeKey } of open) {
		if (!current.has(dedupeKey)) await resolveGeoAlert(db, { organizationId, dedupeKey });
	}
}

export async function expireGeoAdminRequests(db: Db, now: Date = new Date()): Promise<number> {
	return db.transaction(async (tx) => {
		const expired = await tx
			.update(geoAdminRequests)
			.set({ status: "EXPIRED", decidedAt: now })
			.where(and(eq(geoAdminRequests.status, "PENDING"), lt(geoAdminRequests.expiresAt, now)))
			.returning();
		for (const request of expired) {
			await writeGeoAudit(tx, {
				principal: geoSystemPrincipal(request.organizationId, "maintenance", `maintenance-${now.toISOString()}`),
				action: "admin_request.expire",
				entityType: "geo_admin_request",
				entityId: request.id,
				after: request,
				metadata: { kind: request.kind },
			});
		}
		return expired.length;
	});
}

/** When each task entered the review state it is in now. */
async function reviewEntries(db: DbConnection, organizationId: string) {
	return db
		.select({
			id: geoOptimizationTasks.id,
			title: geoOptimizationTasks.title,
			state: geoOptimizationTasks.state,
			enteredAt: sql<Date>`(
				select max(${geoTaskEvents.createdAt}) from ${geoTaskEvents}
				where ${geoTaskEvents.taskId} = ${geoOptimizationTasks.id} and ${geoTaskEvents.toState} = ${geoOptimizationTasks.state}
			)`.mapWith((value) => new Date(value)),
		})
		.from(geoOptimizationTasks)
		.where(
			and(eq(geoOptimizationTasks.organizationId, organizationId), inArray(geoOptimizationTasks.state, REVIEW_STATES)),
		);
}

export interface GeoApprovalTimeouts {
	tasks: { id: string; title: string; state: string; enteredAt: Date }[];
	requests: { id: string; kind: string; createdAt: Date }[];
}

export async function findGeoApprovalTimeouts(
	db: DbConnection,
	organizationId: string,
	now: Date = new Date(),
): Promise<GeoApprovalTimeouts> {
	const taskLimit = now.getTime() - GEO_TASK_REVIEW_OVERDUE_HOURS * HOUR_MS;
	const tasks = (await reviewEntries(db, organizationId)).filter((task) => task.enteredAt.getTime() < taskLimit);
	const requests = await db
		.select({ id: geoAdminRequests.id, kind: geoAdminRequests.kind, createdAt: geoAdminRequests.createdAt })
		.from(geoAdminRequests)
		.where(
			and(
				eq(geoAdminRequests.organizationId, organizationId),
				eq(geoAdminRequests.status, "PENDING"),
				lt(geoAdminRequests.createdAt, new Date(now.getTime() - GEO_ADMIN_REQUEST_OVERDUE_HOURS * HOUR_MS)),
			),
		);
	return { tasks, requests };
}

export async function syncGeoApprovalTimeoutAlerts(
	db: DbConnection,
	organizationId: string,
	now: Date = new Date(),
): Promise<number> {
	const { tasks, requests } = await findGeoApprovalTimeouts(db, organizationId, now);
	const current = new Set<string>();
	for (const task of tasks) {
		const dedupeKey = `approval-timeout:task:${task.id}`;
		current.add(dedupeKey);
		await raiseGeoAlert(db, {
			organizationId,
			kind: "approval-timeout",
			severity: "WARNING",
			dedupeKey,
			context: { taskId: task.id, title: task.title, state: task.state, since: task.enteredAt.toISOString() },
		});
	}
	for (const request of requests) {
		const dedupeKey = `approval-timeout:request:${request.id}`;
		current.add(dedupeKey);
		await raiseGeoAlert(db, {
			organizationId,
			kind: "approval-timeout",
			severity: "WARNING",
			dedupeKey,
			context: { requestId: request.id, kind: request.kind, since: request.createdAt.toISOString() },
		});
	}
	await resolveStale(db, organizationId, "approval-timeout:", current);
	return current.size;
}

export type GeoBackupHealth =
	| { state: "ok"; lastSuccessAt: Date }
	| { state: "failed"; lastSuccessAt: Date | null; failedAt: Date; message: string | null }
	| { state: "stale"; lastSuccessAt: Date | null };

export async function geoBackupHealth(db: DbConnection, now: Date = new Date()): Promise<GeoBackupHealth> {
	const [latest] = await db
		.select()
		.from(geoBackupRuns)
		.where(eq(geoBackupRuns.kind, "DAILY"))
		.orderBy(desc(geoBackupRuns.finishedAt))
		.limit(1);
	const [success] = await db
		.select({ finishedAt: geoBackupRuns.finishedAt })
		.from(geoBackupRuns)
		.where(and(eq(geoBackupRuns.kind, "DAILY"), eq(geoBackupRuns.status, "SUCCEEDED")))
		.orderBy(desc(geoBackupRuns.finishedAt))
		.limit(1);
	const lastSuccessAt = success?.finishedAt ?? null;
	if (latest?.status === "FAILED") {
		return { state: "failed", lastSuccessAt, failedAt: latest.finishedAt, message: latest.message };
	}
	if (!lastSuccessAt || lastSuccessAt.getTime() < now.getTime() - GEO_BACKUP_STALE_HOURS * HOUR_MS) {
		return { state: "stale", lastSuccessAt };
	}
	return { state: "ok", lastSuccessAt };
}

/** One backup covers the instance, so its health is raised on every organization using GEO. */
export async function syncGeoBackupAlerts(db: DbConnection, organizationIds: string[], health: GeoBackupHealth) {
	for (const organizationId of organizationIds) {
		if (health.state === "failed") {
			await raiseGeoAlert(db, {
				organizationId,
				kind: "backup-failed",
				severity: "CRITICAL",
				dedupeKey: "backup-failed",
				context: {
					failedAt: health.failedAt.toISOString(),
					lastSuccessAt: health.lastSuccessAt?.toISOString() ?? null,
				},
			});
		} else {
			await resolveGeoAlert(db, { organizationId, dedupeKey: "backup-failed" });
		}
		if (health.state === "stale") {
			await raiseGeoAlert(db, {
				organizationId,
				kind: "backup-stale",
				severity: "CRITICAL",
				dedupeKey: "backup-stale",
				context: {
					lastSuccessAt: health.lastSuccessAt?.toISOString() ?? null,
					staleAfterHours: GEO_BACKUP_STALE_HOURS,
				},
			});
		} else if (health.state === "ok") {
			await resolveGeoAlert(db, { organizationId, dedupeKey: "backup-stale" });
		}
	}
}

/**
 * Suggests the retest batch for a published task: the earliest settled batch on
 * the baseline's prompt set created after publishing. Linking is all it does;
 * deciding that the change worked stays a person's call.
 */
export async function linkGeoRetestBatches(db: Db, now: Date = new Date()): Promise<number> {
	const waiting = await db
		.select({
			id: geoOptimizationTasks.id,
			organizationId: geoOptimizationTasks.organizationId,
			publishedAt: geoOptimizationTasks.publishedAt,
			promptSetId: geoSamplingBatches.promptSetId,
		})
		.from(geoOptimizationTasks)
		.innerJoin(geoSamplingBatches, eq(geoSamplingBatches.id, geoOptimizationTasks.beforeBatchId))
		.where(and(eq(geoOptimizationTasks.state, "PENDING_RETEST"), isNull(geoOptimizationTasks.afterBatchId)));

	let linked = 0;
	for (const task of waiting) {
		if (!task.publishedAt) continue;
		const [candidate] = await db
			.select({ id: geoSamplingBatches.id })
			.from(geoSamplingBatches)
			.where(
				and(
					eq(geoSamplingBatches.organizationId, task.organizationId),
					eq(geoSamplingBatches.promptSetId, task.promptSetId),
					gt(geoSamplingBatches.createdAt, task.publishedAt),
					inArray(geoSamplingBatches.status, ["COMPLETED", "PARTIAL"]),
				),
			)
			.orderBy(asc(geoSamplingBatches.createdAt))
			.limit(1);
		if (!candidate) continue;

		const done = await db.transaction(async (tx) => {
			const [updated] = await tx
				.update(geoOptimizationTasks)
				.set({ afterBatchId: candidate.id })
				.where(
					and(
						eq(geoOptimizationTasks.id, task.id),
						eq(geoOptimizationTasks.state, "PENDING_RETEST"),
						isNull(geoOptimizationTasks.afterBatchId),
					),
				)
				.returning();
			if (!updated) return false;
			const principal = geoSystemPrincipal(task.organizationId, "task-retest", `retest-${now.toISOString()}`);
			await tx.insert(geoTaskEvents).values({
				organizationId: task.organizationId,
				taskId: task.id,
				fromState: "PENDING_RETEST",
				toState: "PENDING_RETEST",
				action: "LINK_RETEST_BATCH",
				actorId: principal.actorId,
				comment: "已自动关联发布后首个完成的同问法集采样批次，待人工确认验证结论",
			});
			await writeGeoAudit(tx, {
				principal,
				action: "task.link_retest_batch",
				entityType: "geo_optimization_task",
				entityId: task.id,
				after: updated,
				metadata: { afterBatchId: candidate.id },
			});
			return true;
		});
		if (done) linked += 1;
	}
	return linked;
}

/** Settings rows that hold at least one retention period. */
export async function geoRetentionConfigs(db: DbConnection) {
	return db
		.select({
			organizationId: geoOrgSettings.organizationId,
			evidenceRetentionDays: geoOrgSettings.evidenceRetentionDays,
			snapshotRetentionDays: geoOrgSettings.snapshotRetentionDays,
			auditRetentionDays: geoOrgSettings.auditRetentionDays,
		})
		.from(geoOrgSettings)
		.where(
			sql`${geoOrgSettings.evidenceRetentionDays} is not null or ${geoOrgSettings.snapshotRetentionDays} is not null or ${geoOrgSettings.auditRetentionDays} is not null`,
		);
}

export async function unnotifiedGeoAlerts(db: DbConnection) {
	return db
		.select({
			alert: geoAlerts,
			recipients: geoOrgSettings.alertRecipients,
		})
		.from(geoAlerts)
		.innerJoin(geoOrgSettings, eq(geoOrgSettings.organizationId, geoAlerts.organizationId))
		.where(and(eq(geoAlerts.status, "OPEN"), isNull(geoAlerts.notifiedAt)))
		.limit(200);
}

export async function markGeoAlertNotified(db: DbConnection, id: string, at: Date = new Date()): Promise<void> {
	await db.update(geoAlerts).set({ notifiedAt: at }).where(eq(geoAlerts.id, id));
}
