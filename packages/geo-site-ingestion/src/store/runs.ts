import { randomUUID } from "node:crypto";
import { GEO_QUEUE, type GeoCrawlMode, type GeoCrawlStatus, GeoError, type GeoPrincipal } from "@workspace/geo-domain";
import type { DbConnection } from "@workspace/lib/db/db-connection";
import { geoSiteCrawlItems, geoSiteCrawlRuns } from "@workspace/lib/db/schema";
import { writeGeoAudit } from "@workspace/lib/geo/audit";
import { and, count, eq, gte, inArray, sql } from "drizzle-orm";
import { LIMITS } from "../crawl-policy";
import { checkUrl, urlPolicyOf } from "../net/url-policy";
import type { RefusedUrl } from "../source-config";
import type { SendJob } from "./deps";
import { loadSiteSource, profileOfSource, SiteUrlRefusedError } from "./sources";

export type CrawlRunRow = typeof geoSiteCrawlRuns.$inferSelect;

export const ACTIVE_CRAWL_STATUSES: GeoCrawlStatus[] = ["QUEUED", "RUNNING", "PAUSED"];
const MAX_ACTIVE_RUNS_PER_ORG = 3;
const MAX_RUNS_PER_SOURCE_PER_DAY = 48;

export type CrawlTrigger = "MANUAL" | "SCHEDULE" | "RETRY";

export interface CrawlRunConfig {
	/** Null means the source's own seeds, sitemap and known pages. */
	seedUrls: string[] | null;
	followLinks: boolean;
	maxPages: number;
	profileVersion: number;
	trigger: CrawlTrigger;
	retryOf?: string;
}

export function runConfigOf(run: Pick<CrawlRunRow, "config">): CrawlRunConfig {
	const config = (run.config ?? {}) as Partial<CrawlRunConfig>;
	return {
		seedUrls: config.seedUrls ?? null,
		followLinks: config.followLinks ?? true,
		maxPages: config.maxPages ?? LIMITS.defaultMaxPages,
		profileVersion: config.profileVersion ?? 1,
		trigger: config.trigger ?? "MANUAL",
		retryOf: config.retryOf,
	};
}

export interface CreateCrawlRunInput {
	siteSourceId: string;
	mode: GeoCrawlMode;
	urls?: string[];
	followLinks?: boolean;
	maxPages?: number;
	idempotencyKey?: string | null;
	trigger?: CrawlTrigger;
	retryOf?: string;
}

function acceptedSeedUrls(urls: string[] | undefined, policy: ReturnType<typeof urlPolicyOf>): string[] | null {
	if (!urls?.length) return null;
	const refused: RefusedUrl[] = [];
	const accepted: string[] = [];
	for (const url of urls) {
		const decision = checkUrl(url, policy);
		if (decision.ok) accepted.push(decision.url);
		else refused.push({ field: "seedUrls", url, reason: decision.reason });
	}
	if (refused.length > 0) throw new SiteUrlRefusedError(refused);
	return [...new Set(accepted)];
}

async function runByKey(tx: DbConnection, organizationId: string, idempotencyKey: string) {
	const [existing] = await tx
		.select()
		.from(geoSiteCrawlRuns)
		.where(
			and(eq(geoSiteCrawlRuns.organizationId, organizationId), eq(geoSiteCrawlRuns.idempotencyKey, idempotencyKey)),
		)
		.limit(1);
	return existing ?? null;
}

async function activeRunOf(tx: DbConnection, organizationId: string, sourceId: string) {
	const [active] = await tx
		.select()
		.from(geoSiteCrawlRuns)
		.where(
			and(
				eq(geoSiteCrawlRuns.organizationId, organizationId),
				eq(geoSiteCrawlRuns.siteSourceId, sourceId),
				inArray(geoSiteCrawlRuns.status, ACTIVE_CRAWL_STATUSES),
			),
		)
		.limit(1);
	return active ?? null;
}

/** Per-organization concurrency and per-source daily quota (PRD 8.2). */
async function assertQuota(tx: DbConnection, organizationId: string, sourceId: string): Promise<void> {
	const [{ value: activeInOrg }] = await tx
		.select({ value: count() })
		.from(geoSiteCrawlRuns)
		.where(
			and(eq(geoSiteCrawlRuns.organizationId, organizationId), inArray(geoSiteCrawlRuns.status, ACTIVE_CRAWL_STATUSES)),
		);
	if (activeInOrg >= MAX_ACTIVE_RUNS_PER_ORG) {
		throw new GeoError("RATE_LIMITED", `本组织同时进行的采集任务已达上限 ${MAX_ACTIVE_RUNS_PER_ORG} 个`);
	}
	const [{ value: today }] = await tx
		.select({ value: count() })
		.from(geoSiteCrawlRuns)
		.where(
			and(
				eq(geoSiteCrawlRuns.siteSourceId, sourceId),
				gte(geoSiteCrawlRuns.createdAt, sql`now() - interval '24 hours'`),
			),
		);
	if (today >= MAX_RUNS_PER_SOURCE_PER_DAY) {
		throw new GeoError("RATE_LIMITED", `该站点 24 小时内的采集次数已达上限 ${MAX_RUNS_PER_SOURCE_PER_DAY} 次`);
	}
}

/**
 * Only records the run; the caller enqueues it once the transaction commits.
 * One active run per source: asking again returns the run already going.
 */
export async function createCrawlRun(
	tx: DbConnection,
	principal: GeoPrincipal,
	input: CreateCrawlRunInput,
): Promise<{ run: CrawlRunRow; created: boolean }> {
	const { organizationId } = principal;
	const source = await loadSiteSource(tx, organizationId, input.siteSourceId);
	if (!source.enabled) throw new GeoError("CONFLICT", "站点采集已暂停，请先恢复站点");
	const profile = profileOfSource(source);
	const seedUrls = acceptedSeedUrls(input.urls, urlPolicyOf(source.allowedHosts, profile));

	const existing =
		(input.idempotencyKey ? await runByKey(tx, organizationId, input.idempotencyKey) : null) ??
		(await activeRunOf(tx, organizationId, source.id));
	if (existing) return { run: existing, created: false };
	await assertQuota(tx, organizationId, source.id);

	const config: CrawlRunConfig = {
		seedUrls,
		followLinks: input.followLinks ?? seedUrls === null,
		maxPages: Math.min(input.maxPages ?? source.maxPages ?? LIMITS.defaultMaxPages, LIMITS.hardMaxPages),
		profileVersion: profile.version,
		trigger: input.trigger ?? "MANUAL",
		retryOf: input.retryOf,
	};
	const idempotencyKey = input.idempotencyKey ?? `${config.trigger.toLowerCase()}:${source.id}:${randomUUID()}`;
	const [run] = await tx
		.insert(geoSiteCrawlRuns)
		.values({
			organizationId,
			siteSourceId: source.id,
			mode: input.mode,
			status: "QUEUED",
			policyVersion: source.policyVersion,
			config,
			idempotencyKey,
			requestedBy: principal.actorId,
		})
		.onConflictDoNothing()
		.returning();
	if (!run) return { run: (await runByKey(tx, organizationId, idempotencyKey)) as CrawlRunRow, created: false };
	await writeGeoAudit(tx, {
		principal,
		action: "site.crawl.create",
		entityType: "site_crawl_run",
		entityId: run.id,
		after: { mode: run.mode, config },
		metadata: { siteSourceId: source.id, trigger: config.trigger, urlCount: seedUrls?.length ?? 0 },
	});
	return { run, created: true };
}

export function crawlJobOptions(runId: string) {
	return { singletonKey: `crawl:${runId}` };
}

export async function enqueueCrawlRun(send: SendJob, run: Pick<CrawlRunRow, "id" | "organizationId">) {
	return send(GEO_QUEUE.siteCrawl, { organizationId: run.organizationId, runId: run.id }, crawlJobOptions(run.id));
}

export async function loadCrawlRun(db: DbConnection, organizationId: string, runId: string): Promise<CrawlRunRow> {
	const [run] = await db
		.select()
		.from(geoSiteCrawlRuns)
		.where(and(eq(geoSiteCrawlRuns.organizationId, organizationId), eq(geoSiteCrawlRuns.id, runId)))
		.limit(1);
	if (!run) throw new GeoError("NOT_FOUND", "采集任务不存在");
	return run;
}

export async function setCrawlRunPaused(
	tx: DbConnection,
	principal: GeoPrincipal,
	runId: string,
	paused: boolean,
): Promise<CrawlRunRow> {
	const run = await loadCrawlRun(tx, principal.organizationId, runId);
	const from: GeoCrawlStatus[] = paused ? ["QUEUED", "RUNNING"] : ["PAUSED"];
	if (!from.includes(run.status)) {
		throw new GeoError("CONFLICT", paused ? "只有排队或运行中的任务可以暂停" : "只有已暂停的任务可以恢复");
	}
	const [updated] = await tx
		.update(geoSiteCrawlRuns)
		.set({ status: paused ? "PAUSED" : "QUEUED" })
		.where(and(eq(geoSiteCrawlRuns.id, run.id), inArray(geoSiteCrawlRuns.status, from)))
		.returning();
	if (!updated) throw new GeoError("CONFLICT", "任务状态已变化，请刷新后重试");
	if (!paused) {
		await tx
			.update(geoSiteCrawlItems)
			.set({ status: "QUEUED" })
			.where(and(eq(geoSiteCrawlItems.runId, run.id), eq(geoSiteCrawlItems.status, "FETCHING")));
	}
	await writeGeoAudit(tx, {
		principal,
		action: paused ? "site.crawl.pause" : "site.crawl.resume",
		entityType: "site_crawl_run",
		entityId: run.id,
		before: { status: run.status },
		after: { status: updated.status },
	});
	return updated;
}

/** The URLs of a run that ended in failure, for a follow-up run that tries exactly those again. */
export async function failedUrlsOf(db: DbConnection, organizationId: string, runId: string): Promise<string[]> {
	const rows = await db
		.select({ url: geoSiteCrawlItems.url })
		.from(geoSiteCrawlItems)
		.where(
			and(
				eq(geoSiteCrawlItems.organizationId, organizationId),
				eq(geoSiteCrawlItems.runId, runId),
				eq(geoSiteCrawlItems.status, "FAILED"),
				eq(geoSiteCrawlItems.isAsset, false),
			),
		)
		.limit(LIMITS.hardMaxPages);
	return rows.map((row) => row.url);
}
