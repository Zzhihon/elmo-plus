import { GEO_QUEUE, GeoError, geoSystemPrincipal } from "@workspace/geo-domain";
import {
	geoAssertionSources,
	geoAuditLogs,
	geoKnowledgeAssertions,
	geoSiteCrawlItems,
	geoSiteCrawlRuns,
	geoSitePages,
	geoSitePageVersions,
	geoSiteSources,
} from "@workspace/lib/db/schema";
import { raiseGeoAlert, resolveGeoAlert } from "@workspace/lib/geo/alerts";
import { and, desc, eq, gte, isNull, lt, ne, sql } from "drizzle-orm";
import { parseOpWindow } from "../profile";
import { DEFAULT_CRAWL_CRON, DEFAULT_TIMEZONE, lastCronFireBetween } from "../schedule";
import { nowOf, type SiteJobDeps } from "./deps";
import { createCrawlRun, enqueueCrawlRun } from "./runs";
import { profileOfSource } from "./sources";

const RECOVERY_LIMIT = 200;

export interface SiteTickResult {
	scheduled: number;
	requeuedRuns: number;
	requeuedParses: number;
	requeuedNormalizations: number;
}

async function scheduleDueCrawls(deps: SiteJobDeps, now: Date): Promise<number> {
	const sources = await deps.db.select().from(geoSiteSources).where(eq(geoSiteSources.enabled, true));
	let scheduled = 0;
	for (const source of sources) {
		const [last] = await deps.db
			.select({ createdAt: geoSiteCrawlRuns.createdAt })
			.from(geoSiteCrawlRuns)
			.where(
				and(eq(geoSiteCrawlRuns.siteSourceId, source.id), sql`${geoSiteCrawlRuns.config}->>'trigger' = 'SCHEDULE'`),
			)
			.orderBy(desc(geoSiteCrawlRuns.createdAt))
			.limit(1);
		const timezone = parseOpWindow(source.opWindow)?.timezone ?? DEFAULT_TIMEZONE;
		const fire = lastCronFireBetween(
			source.crawlCron ?? DEFAULT_CRAWL_CRON,
			last?.createdAt ?? source.createdAt,
			now,
			timezone,
		);
		if (!fire) continue;
		const principal = geoSystemPrincipal(source.organizationId, "site-schedule", `schedule-${source.id}`);
		try {
			const { run, created } = await deps.db.transaction((tx) =>
				createCrawlRun(tx, principal, {
					siteSourceId: source.id,
					mode: "INCREMENTAL",
					trigger: "SCHEDULE",
					idempotencyKey: `schedule:${source.id}:${fire.toISOString()}`,
				}),
			);
			if (created) {
				await enqueueCrawlRun(deps.send, run);
				scheduled++;
			}
		} catch (error) {
			if (!(error instanceof GeoError)) throw error;
		}
	}
	return scheduled;
}

async function raiseOrResolve(
	deps: SiteJobDeps,
	organizationId: string,
	dedupeKey: string,
	raise: boolean,
	alert: { kind: string; severity: "CRITICAL" | "WARNING" | "INFO"; context: Record<string, unknown> },
) {
	if (raise) await raiseGeoAlert(deps.db, { organizationId, dedupeKey, ...alert });
	else await resolveGeoAlert(deps.db, { organizationId, dedupeKey });
}

/** PRD 10.4 alerts that depend on time rather than on one run finishing. */
async function evaluateStandingAlerts(deps: SiteJobDeps, now: Date): Promise<void> {
	const sources = await deps.db.select().from(geoSiteSources).where(eq(geoSiteSources.enabled, true));
	const slaByOrg = new Map<string, number>();
	for (const source of sources) {
		const profile = profileOfSource(source);
		slaByOrg.set(
			source.organizationId,
			Math.min(slaByOrg.get(source.organizationId) ?? Number.POSITIVE_INFINITY, profile.alerts.reviewSlaDays),
		);
		const [parse] = await deps.db
			.select({
				versions: sql<number>`count(*)::int`,
				failed: sql<number>`count(*) filter (where ${geoSitePageVersions.parseStatus} = 'FAILED')::int`,
			})
			.from(geoSitePageVersions)
			.innerJoin(geoSitePages, eq(geoSitePages.id, geoSitePageVersions.pageId))
			.where(
				and(
					eq(geoSitePages.siteSourceId, source.id),
					ne(geoSitePageVersions.parseStatus, "SKIPPED"),
					gte(geoSitePageVersions.createdAt, sql`now() - interval '24 hours'`),
				),
			);
		const rate = parse && parse.versions >= 10 ? 1 - parse.failed / parse.versions : null;
		await raiseOrResolve(
			deps,
			source.organizationId,
			`site-parse-rate:${source.id}`,
			rate !== null && rate < profile.alerts.parseSuccessMin,
			{
				kind: "site.parse_rate",
				severity: "WARNING",
				context: {
					siteSourceId: source.id,
					versions: parse?.versions,
					failed: parse?.failed,
					threshold: profile.alerts.parseSuccessMin,
				},
			},
		);
		const staleSince = new Date(now.getTime() - 48 * 60 * 60 * 1000);
		const stale = (source.lastSuccessAt ?? source.createdAt) < staleSince;
		await raiseOrResolve(deps, source.organizationId, `site-sync-stale:${source.id}`, stale, {
			kind: "site.sync_stale",
			severity: "WARNING",
			context: { siteSourceId: source.id, lastSuccessAt: source.lastSuccessAt },
		});
	}
	for (const [organizationId, slaDays] of slaByOrg) {
		const [backlog] = await deps.db
			.select({ pending: sql<number>`count(distinct ${geoKnowledgeAssertions.id})::int` })
			.from(geoKnowledgeAssertions)
			.innerJoin(geoAssertionSources, eq(geoAssertionSources.assertionId, geoKnowledgeAssertions.id))
			.where(
				and(
					eq(geoKnowledgeAssertions.organizationId, organizationId),
					eq(geoKnowledgeAssertions.status, "PENDING_REVIEW"),
					eq(geoAssertionSources.sourceKind, "PAGE_VERSION"),
					lt(geoKnowledgeAssertions.createdAt, sql`now() - (${slaDays} * interval '1 day')`),
				),
			);
		await raiseOrResolve(deps, organizationId, "site-review-backlog", (backlog?.pending ?? 0) > 0, {
			kind: "site.review_backlog",
			severity: "WARNING",
			context: { overdue: backlog?.pending ?? 0, slaDays },
		});
	}
}

/**
 * Jobs are sent after their rows commit, so a crash in between leaves a row
 * with no job. This finds such rows and sends their job again; the singleton
 * keys and the unique version key make a duplicate send harmless.
 */
async function recoverStranded(deps: SiteJobDeps): Promise<Omit<SiteTickResult, "scheduled">> {
	const strandedRuns = await deps.db
		.select({ id: geoSiteCrawlRuns.id, organizationId: geoSiteCrawlRuns.organizationId })
		.from(geoSiteCrawlRuns)
		.where(
			sql`(${geoSiteCrawlRuns.status} = 'QUEUED'
				and ${geoSiteCrawlRuns.createdAt} < now() - interval '10 minutes'
				and coalesce((${geoSiteCrawlRuns.counts}->'meta'->>'resumeAt')::timestamptz, '-infinity') < now())
			or (${geoSiteCrawlRuns.status} = 'RUNNING'
				and coalesce(${geoSiteCrawlRuns.startedAt}, ${geoSiteCrawlRuns.createdAt}) < now() - interval '15 minutes'
				and not exists (
					select 1 from ${geoSiteCrawlItems} i
					where i.run_id = ${geoSiteCrawlRuns.id} and i.updated_at > now() - interval '15 minutes'))`,
		)
		.limit(RECOVERY_LIMIT);
	for (const run of strandedRuns) await enqueueCrawlRun(deps.send, run);

	const strandedItems = await deps.db
		.select({ id: geoSiteCrawlItems.id, organizationId: geoSiteCrawlItems.organizationId })
		.from(geoSiteCrawlItems)
		.where(
			and(
				eq(geoSiteCrawlItems.outcome, "NEW_VERSION"),
				isNull(geoSiteCrawlItems.versionId),
				lt(geoSiteCrawlItems.updatedAt, sql`now() - interval '15 minutes'`),
			),
		)
		.limit(RECOVERY_LIMIT);
	for (const item of strandedItems) {
		await deps.send(
			GEO_QUEUE.siteParse,
			{ organizationId: item.organizationId, itemId: item.id },
			{ singletonKey: `parse:${item.id}` },
		);
	}

	const unnormalized = await deps.db
		.select({ id: geoSitePageVersions.id, organizationId: geoSitePageVersions.organizationId })
		.from(geoSitePageVersions)
		.where(
			and(
				eq(geoSitePageVersions.parseStatus, "PARSED"),
				lt(geoSitePageVersions.createdAt, sql`now() - interval '15 minutes'`),
				gte(geoSitePageVersions.createdAt, sql`now() - interval '3 days'`),
				sql`not exists (
					select 1 from ${geoAuditLogs} a
					where a.organization_id = ${geoSitePageVersions.organizationId}
						and a.entity_type = 'site_page_version'
						and a.entity_id = ${geoSitePageVersions.id}::text
						and a.action = 'site.normalize')`,
			),
		)
		.limit(RECOVERY_LIMIT);
	for (const version of unnormalized) {
		await deps.send(
			GEO_QUEUE.siteNormalize,
			{ organizationId: version.organizationId, versionId: version.id },
			{ singletonKey: `normalize:${version.id}` },
		);
	}
	return {
		requeuedRuns: strandedRuns.length,
		requeuedParses: strandedItems.length,
		requeuedNormalizations: unnormalized.length,
	};
}

/** The periodic site job: due incremental crawls, stranded work, and standing alerts. */
export async function tickSiteSchedules(deps: SiteJobDeps): Promise<SiteTickResult> {
	const now = nowOf(deps);
	const scheduled = await scheduleDueCrawls(deps, now);
	const recovered = await recoverStranded(deps);
	await evaluateStandingAlerts(deps, now);
	return { scheduled, ...recovered };
}
