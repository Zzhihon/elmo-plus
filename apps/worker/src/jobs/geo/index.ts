import type { Job, PgBoss } from "pg-boss";
import { GEO_EVALUATION_QUEUES } from "./evaluation";
import { GEO_KNOWLEDGE_QUEUES } from "./knowledge";
import { GEO_PROFILE_QUEUES } from "./profile";
import type { GeoQueue } from "./queue";
import { GEO_REPORTS_QUEUES } from "./reports";
import { GEO_SAMPLING_QUEUES } from "./sampling";
import { GEO_SITE_QUEUES } from "./site";
import { GEO_SITE_AUDIT_QUEUES } from "./site-audit";
import { GEO_TASKS_QUEUES } from "./tasks";

export function allGeoQueues(): GeoQueue[] {
	const queues = [
		...GEO_PROFILE_QUEUES,
		...GEO_SITE_QUEUES,
		...GEO_SITE_AUDIT_QUEUES,
		...GEO_KNOWLEDGE_QUEUES,
		...GEO_SAMPLING_QUEUES,
		...GEO_EVALUATION_QUEUES,
		...GEO_REPORTS_QUEUES,
		...GEO_TASKS_QUEUES,
	];
	const names = new Set<string>();
	for (const { name } of queues) {
		if (!name.startsWith("geo-")) throw new Error(`GEO queue "${name}" must start with "geo-"`);
		if (names.has(name)) throw new Error(`GEO queue "${name}" is declared twice`);
		names.add(name);
	}
	return queues;
}

export async function createGeoQueues(boss: PgBoss, queues: GeoQueue[] = allGeoQueues()): Promise<void> {
	for (const { name, options, schedule } of queues) {
		await boss.createQueue(name, options);
		if (schedule) {
			await boss.schedule(name, schedule.cron, schedule.data ?? {}, {
				tz: "UTC",
				singletonKey: name,
				...schedule.options,
			});
		}
	}
	console.log(`Created ${queues.length} GEO queues`);
}

type HandlerWrapper = <T, R>(
	queueName: string,
	handler: (jobs: Job<T>[]) => Promise<R>,
) => (jobs: Job<T>[]) => Promise<R>;

export async function registerGeoHandlers(
	boss: PgBoss,
	wrap: HandlerWrapper,
	queues: GeoQueue[] = allGeoQueues(),
): Promise<void> {
	for (const { name, work, handler } of queues) {
		await boss.work(name, work, wrap(name, handler));
		console.log(`Registered handler: ${name}`);
	}
}
