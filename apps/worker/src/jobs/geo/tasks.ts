import { randomUUID } from "node:crypto";
import { GEO_QUEUE } from "@workspace/geo-domain";
import { getObjectStore } from "@workspace/geo-evidence";
import { db } from "@workspace/lib/db/db";
import { purgeExpiredGeoIdempotencyKeys } from "@workspace/lib/geo/idempotency";
import {
	expireGeoAdminRequests,
	geoActiveOrganizationIds,
	geoBackupHealth,
	geoRetentionConfigs,
	linkGeoRetestBatches,
	markGeoAlertNotified,
	syncGeoApprovalTimeoutAlerts,
	syncGeoBackupAlerts,
	unnotifiedGeoAlerts,
} from "@workspace/lib/geo/maintenance";
import { purgeExpiredGeoData } from "@workspace/lib/geo/retention";
import { defineGeoQueue, type GeoQueue } from "./queue";

const ALERT_KIND_LABELS: Record<string, string> = {
	"approval-timeout": "审批超时",
	"backup-failed": "数据库备份失败",
	"backup-stale": "超过 26 小时没有成功的备份",
};

/** Mail goes out only where the deployment has a transport; alerts always show in the workspace. */
async function notifyAlerts(): Promise<number> {
	if (!process.env.RESEND_API_KEY || !process.env.RESEND_FROM_EMAIL) return 0;
	const { sendEmail } = await import("@workspace/deployment/email");
	let sent = 0;
	for (const { alert, recipients } of await unnotifiedGeoAlerts(db)) {
		if (recipients.length === 0) {
			await markGeoAlertNotified(db, alert.id);
			continue;
		}
		const label = ALERT_KIND_LABELS[alert.kind] ?? alert.kind;
		const subject = `[GEO 告警][${alert.severity}] ${label}`;
		const text = `${label}\n级别：${alert.severity}\n首次出现：${alert.firstSeen.toISOString()}\n请登录 GEO 工作台「设置 › 运行状态」查看详情。`;
		const results = await Promise.allSettled(
			recipients.map((to) => sendEmail(to, { subject, text, html: `<pre>${text.replace(/[<>&]/g, "")}</pre>` })),
		);
		// One reachable recipient is enough; a resend loop would spam the others.
		if (results.some((result) => result.status === "fulfilled")) {
			await markGeoAlertNotified(db, alert.id);
			sent += 1;
		} else {
			console.error(`[geo-maintenance] could not send alert ${alert.id} to any recipient`);
		}
	}
	return sent;
}

async function runMaintenance(): Promise<void> {
	const purgedKeys = await purgeExpiredGeoIdempotencyKeys(db);
	const expired = await expireGeoAdminRequests(db);
	const organizations = await geoActiveOrganizationIds(db);
	let overdue = 0;
	for (const organizationId of organizations) overdue += await syncGeoApprovalTimeoutAlerts(db, organizationId);
	const health = await geoBackupHealth(db);
	await syncGeoBackupAlerts(db, organizations, health);
	const notified = await notifyAlerts();
	console.log(
		`[geo-maintenance] idempotency keys purged=${purgedKeys} requests expired=${expired} overdue approvals=${overdue} backup=${health.state} alerts mailed=${notified}`,
	);
}

async function runRetention(): Promise<void> {
	const store = getObjectStore();
	for (const config of await geoRetentionConfigs(db)) {
		const result = await purgeExpiredGeoData(db, config.organizationId, config, {
			deleteObject: (key) => store.delete(key),
			requestId: `retention-${randomUUID()}`,
		});
		const summary = Object.entries(result)
			.map(([category, outcome]) => `${category}=${JSON.stringify(outcome.rows)} objects=${outcome.objectsDeleted}`)
			.join(" ");
		console.log(`[geo-retention] org=${config.organizationId} ${summary}`);
	}
}

export const GEO_TASKS_QUEUES: GeoQueue[] = [
	defineGeoQueue({
		name: GEO_QUEUE.maintenance,
		options: { retryLimit: 1, retryDelay: 300, expireInSeconds: 15 * 60 },
		work: { batchSize: 1, localConcurrency: 1 },
		handler: async () => runMaintenance(),
		schedule: { cron: "17 * * * *" },
	}),
	defineGeoQueue({
		name: "geo-retention",
		options: { retryLimit: 2, retryDelay: 600, retryBackoff: true, expireInSeconds: 2 * 60 * 60 },
		work: { batchSize: 1, localConcurrency: 1 },
		handler: async () => runRetention(),
		schedule: { cron: "40 3 * * *" },
	}),
	defineGeoQueue({
		name: GEO_QUEUE.taskRetest,
		options: { retryLimit: 1, retryDelay: 300, expireInSeconds: 15 * 60 },
		work: { batchSize: 1, localConcurrency: 1 },
		handler: async () => {
			const linked = await linkGeoRetestBatches(db);
			if (linked > 0) console.log(`[geo-task-retest] linked ${linked} retest batches`);
		},
		schedule: { cron: "47 * * * *" },
	}),
];
