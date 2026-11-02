import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { GEO_QUEUE, type GeoPrincipal } from "@workspace/geo-domain";
import { FsObjectStore } from "@workspace/geo-evidence";
import { safeFetch } from "@workspace/geo-site-ingestion";
import { processSiteAuditRun } from "@workspace/geo-site-ingestion/audit/store";
import {
	createCrawlRun,
	normalizeSiteVersion,
	parseCrawlItem,
	processCrawlRun,
	type SiteJobDeps,
	tickSiteSchedules,
} from "@workspace/geo-site-ingestion/store";
import { db } from "@workspace/lib/db/db";
import {
	geoAssertionConflicts,
	geoKnowledgeAssertions,
	geoSiteAuditFindings,
	geoSiteCrawlRuns,
	geoSitePages,
	geoSitePageVersions,
} from "@workspace/lib/db/schema";
import { and, desc, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	getClaimDetail,
	knowledgeOverview,
	listConflicts,
	reviewClaim,
	searchClaims,
	searchEntities,
} from "@/server/geo/knowledge-core";
import {
	createTasksFromFindings,
	getSiteAuditFinding,
	getSiteAuditOverview,
	listSiteAuditFindingGroups,
	listSiteAuditFindings,
} from "@/server/geo/site-audit-core";
import {
	createQaSample,
	createSite,
	getKeyUrlCoverage,
	getPageVersion,
	getQaSample,
	getSite,
	getSitePage,
	getSnapshotForViewing,
	labelQaItem,
	listSitePages,
	setKeyUrls,
} from "@/server/geo/site-core";
import { createGeoOrganization } from "@/test/integration/geo-fixtures";

const HOST = `site-${randomUUID().slice(0, 8)}.example-electric.test`;
const BASE = `http://${HOST}/`;

let server: Server;
let port: number;
let objectRoot: string;
let voltage = "12kV";
let retiredPageGone = false;

function page(title: string, body: string): string {
	return `<!doctype html><html lang="zh-CN"><head><title>${title}</title></head><body><main><h1>${title}</h1>${body}</main></body></html>`;
}

function startFakeSite(): Promise<void> {
	server = createServer((request, response) => {
		const html = (status: number, body: string) => {
			response.writeHead(status, { "content-type": "text/html; charset=utf-8" });
			response.end(body);
		};
		switch (request.url) {
			case "/robots.txt":
				response.writeHead(200, { "content-type": "text/plain" });
				return response.end(`User-agent: *\nAllow: /\nSitemap: ${BASE}sitemap.xml\n`);
			case "/sitemap.xml":
				response.writeHead(200, { "content-type": "application/xml" });
				return response.end(
					`<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${[
						"",
						"products/xg900",
						"products/retired",
					]
						.map((p) => `<url><loc>${BASE}${p}</loc></url>`)
						.join("")}</urlset>`,
				);
			case "/":
				return html(
					200,
					page("示例电气", '<a href="/products/xg900">XG-900</a> <a href="/products/retired">旧型号</a>'),
				);
			case "/products/xg900":
				return html(
					200,
					page("XG-900 高压开关柜", `<p>额定电压：<span class="spec-voltage">${voltage}</span></p><p>适用于配电。</p>`),
				);
			case "/products/retired":
				if (retiredPageGone) return html(404, page("未找到", "页面不存在"));
				return html(200, page("XGN15 环网柜", '<p>额定电压：<span class="spec-voltage">10kV</span></p>'));
			default:
				return html(404, page("未找到", "页面不存在"));
		}
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			port = (server.address() as AddressInfo).port;
			resolve();
		});
	});
}

/**
 * The real safe fetch, with only the port and the address mapped to the local server:
 * the host allowlist, redirect checks and size limits still apply.
 */
const localFetch: NonNullable<SiteJobDeps["fetch"]> = async (url, options) => {
	const toLocal = (value: string) => value.replace(`://${HOST}/`, `://${HOST}:${port}/`);
	const fromLocal = (value: string) => value.replace(`://${HOST}:${port}/`, `://${HOST}/`);
	if (!url.startsWith("http://")) {
		return {
			ok: false,
			code: "NETWORK",
			detail: "测试中没有 HTTPS 服务",
			url,
			finalUrl: url,
			redirects: [],
			durationMs: 0,
		};
	}
	const result = await safeFetch(toLocal(url), {
		...options,
		allowedPorts: [port],
		resolve: async () => [{ address: "127.0.0.1", family: 4 }],
		addressAllowed: (address) => address === "127.0.0.1",
	});
	return {
		...result,
		url: fromLocal(result.url),
		finalUrl: fromLocal(result.finalUrl),
		redirects: result.redirects.map((hop) => ({ ...hop, from: fromLocal(hop.from), to: fromLocal(hop.to) })),
	};
};

const jobs: { queue: string; data: Record<string, unknown> }[] = [];
let deps: SiteJobDeps;

/** Plays the site queues until nothing is left. */
async function drain(): Promise<void> {
	for (let round = 0; round < 200; round++) {
		const job = jobs.shift();
		if (!job) return;
		const data = job.data as { organizationId: string; runId: string; itemId: string; versionId: string };
		if (job.queue === GEO_QUEUE.siteCrawl) await processCrawlRun(deps, data);
		else if (job.queue === GEO_QUEUE.siteParse) await parseCrawlItem(deps, data);
		else if (job.queue === GEO_QUEUE.siteNormalize) await normalizeSiteVersion(deps, data);
		else if (job.queue === GEO_QUEUE.siteAudit) await processSiteAuditRun(deps, data);
	}
	throw new Error("site jobs kept coming");
}

let organizationId: string;
let admin: GeoPrincipal;
let operator: GeoPrincipal;
let knowledgeReviewer: GeoPrincipal;
let siteId: string;

async function crawl(mode: "FULL" | "INCREMENTAL") {
	const { run } = await db.transaction((tx) =>
		createCrawlRun(tx, operator, { siteSourceId: siteId, mode, trigger: "MANUAL" }),
	);
	jobs.push({ queue: GEO_QUEUE.siteCrawl, data: { organizationId, runId: run.id } });
	await drain();
	const [after] = await db.select().from(geoSiteCrawlRuns).where(eq(geoSiteCrawlRuns.id, run.id));
	return after;
}

async function pageByPath(suffix: string) {
	const [row] = await db
		.select()
		.from(geoSitePages)
		.where(and(eq(geoSitePages.siteSourceId, siteId), eq(geoSitePages.normalizedUrl, `${BASE}${suffix}`)));
	return row;
}

async function voltageAssertions() {
	return db
		.select()
		.from(geoKnowledgeAssertions)
		.where(
			and(
				eq(geoKnowledgeAssertions.organizationId, organizationId),
				eq(geoKnowledgeAssertions.fieldPath, "ratedVoltage"),
			),
		);
}

beforeAll(async () => {
	objectRoot = await mkdtemp(path.join(tmpdir(), "geo-site-objects-"));
	vi.stubEnv("GEO_OBJECT_STORE_URL", `file://${objectRoot}`);
	await startFakeSite();
	deps = {
		db,
		objectStore: new FsObjectStore(objectRoot),
		send: async (queue, data) => {
			jobs.push({ queue, data: data as Record<string, unknown> });
			return randomUUID();
		},
		fetch: localFetch,
		sleep: async () => {},
		workerId: "integration-test",
	};
	const org = await createGeoOrganization();
	organizationId = org.organizationId;
	admin = await org.actor(["platform_admin"]);
	operator = await org.actor(["geo_operator"]);
	knowledgeReviewer = await org.actor(["knowledge_reviewer"]);
	const site = await createSite(admin, {
		baseUrl: BASE,
		allowedHosts: [HOST],
		seedUrls: [BASE],
		profile: {
			id: "example-electric",
			version: 1,
			categories: [
				{
					key: "product",
					label: "产品",
					urlPatterns: ["^/products/"],
					role: "detail",
					entityKind: "PRODUCT",
					fields: [
						{
							path: "ratedVoltage",
							label: "额定电压",
							selector: [".spec-voltage"],
							claimType: "PRODUCT_DESCRIPTION",
							risk: "NORMAL",
						},
					],
				},
			],
		},
	});
	siteId = site.id;
});

afterAll(async () => {
	await new Promise((resolve) => server.close(resolve));
	await rm(objectRoot, { recursive: true, force: true });
});

describe("crawling an authorized site", () => {
	it("fetches, parses and normalizes every page into candidate facts awaiting review", async () => {
		const run = await crawl("FULL");
		expect(run.status).toBe("SUCCEEDED");
		const product = await pageByPath("products/xg900");
		expect(product).toMatchObject({ status: "ACTIVE", httpStatus: 200, category: "product" });
		const versions = await db.select().from(geoSitePageVersions).where(eq(geoSitePageVersions.pageId, product.id));
		expect(versions).toHaveLength(1);
		expect(versions[0]?.parseStatus).toBe("PARSED");

		const assertions = await voltageAssertions();
		expect(assertions.map((row) => [row.status, row.claimText]).sort()).toEqual([
			["PENDING_REVIEW", "XG-900 高压开关柜｜额定电压：12kV"],
			["PENDING_REVIEW", "XGN15 环网柜｜额定电压：10kV"],
		]);
	});

	it("makes no new version when nothing changed, and marks a page that went away", async () => {
		retiredPageGone = true;
		const run = await crawl("FULL");
		expect(["SUCCEEDED", "PARTIAL"]).toContain(run.status);
		const product = await pageByPath("products/xg900");
		const versions = await db.select().from(geoSitePageVersions).where(eq(geoSitePageVersions.pageId, product.id));
		expect(versions).toHaveLength(1);

		const retired = await pageByPath("products/retired");
		expect(retired).toMatchObject({ status: "GONE", httpStatus: 404 });
		const assertions = await voltageAssertions();
		expect(assertions.find((row) => row.claimText.includes("10kV"))?.status).toBe("SOURCE_UNAVAILABLE");
	});

	it("opens a conflict when a later crawl finds a different value for an approved fact", async () => {
		const [approved] = (await voltageAssertions()).filter((row) => row.claimText.includes("12kV"));
		await reviewClaim(knowledgeReviewer, approved.id, {
			decision: "APPROVE",
			basis: "与产品样本一致",
			publicationScope: "PUBLIC",
		});

		voltage = "24kV";
		await crawl("FULL");
		const product = await pageByPath("products/xg900");
		const versions = await db.select().from(geoSitePageVersions).where(eq(geoSitePageVersions.pageId, product.id));
		expect(versions).toHaveLength(2);
		const candidate = (await voltageAssertions()).find((row) => row.claimText.includes("24kV"));
		expect(candidate?.status).toBe("PENDING_REVIEW");
		const conflicts = await db
			.select()
			.from(geoAssertionConflicts)
			.where(eq(geoAssertionConflicts.organizationId, organizationId));
		expect(conflicts).toEqual([
			expect.objectContaining({ candidateId: candidate?.id, approvedId: approved.id, status: "OPEN" }),
		]);
		const { rows } = await listConflicts(knowledgeReviewer, {}, { limit: 20, offset: 0 });
		expect(rows).toHaveLength(1);
		// The approved fact is never overwritten by the crawl.
		const [still] = await db.select().from(geoKnowledgeAssertions).where(eq(geoKnowledgeAssertions.id, approved.id));
		expect(still?.status).toBe("APPROVED");
	});

	it("lists each page with its latest version and counts parsed key pages as covered", async () => {
		const { rows } = await listSitePages(operator, { siteId }, { page: 1, limit: 50, offset: 0 });
		const product = rows.find((row) => row.url === `${BASE}products/xg900`);
		const [latest] = await db
			.select()
			.from(geoSitePageVersions)
			.where(eq(geoSitePageVersions.pageId, product?.id as string))
			.orderBy(desc(geoSitePageVersions.fetchedAt))
			.limit(1);
		expect(product).toMatchObject({
			currentVersionId: latest?.id,
			title: "XG-900 高压开关柜",
			parseStatus: "PARSED",
			versionCount: 2,
		});

		await setKeyUrls(admin, siteId, [`${BASE}products/xg900`, `${BASE}products/retired`]);
		const coverage = await getKeyUrlCoverage(operator, siteId);
		expect(coverage.statuses.map((entry) => [entry.url, entry.status, entry.parsed])).toEqual([
			[`${BASE}products/xg900`, "ACTIVE", true],
			[`${BASE}products/retired`, "GONE", true],
		]);
		expect(coverage).toMatchObject({ covered: 1 });
	});

	it("shows a page's versions, the diff between them, its snapshot and a QA spot check", async () => {
		const product = await pageByPath("products/xg900");
		const detail = await getSitePage(operator, product.id);
		expect(detail.versions).toHaveLength(2);
		expect(detail.assertions.map((row) => row.claimText).sort()).toEqual([
			"XG-900 高压开关柜｜额定电压：12kV",
			"XG-900 高压开关柜｜额定电压：24kV",
		]);
		const [newest, older] = detail.versions;
		const version = await getPageVersion(operator, product.id, newest.id);
		expect(version.compareTo?.id).toBe(older.id);
		expect(JSON.stringify(version.diff)).toContain("24kV");
		const snapshot = await getSnapshotForViewing(operator, newest.id);
		expect(JSON.stringify(snapshot)).toContain("24kV");

		const site = await getSite(operator, siteId);
		expect(site.metrics.parse.versions).toBeGreaterThanOrEqual(4);
		const sample = await createQaSample(operator, siteId, 30);
		const qa = await getQaSample(operator, sample.id);
		expect(qa.items.length).toBeGreaterThan(0);
		await labelQaItem(operator, qa.items[0].id, { verdict: "CORRECT" });
	});

	it("finds facts by Chinese keyword and shows where each came from", async () => {
		const { rows } = await searchClaims(operator, { q: "开关柜" }, { limit: 20, offset: 0 });
		expect(rows.length).toBe(2);
		const detail = await getClaimDetail(operator, rows[0].id);
		expect(JSON.stringify(detail)).toContain(`${BASE}products/xg900`);
		const overview = await knowledgeOverview(operator);
		expect(overview).toBeTruthy();
		const entities = await searchEntities(operator, { q: "XG-900" });
		expect(entities).toEqual([expect.objectContaining({ title: "XG-900 高压开关柜", pageCount: 1 })]);
	});

	it("audits the stored pages after a crawl and turns a finding into a task", async () => {
		const overview = await getSiteAuditOverview(operator, siteId);
		expect(overview).toBeTruthy();
		const listed = await listSiteAuditFindings(operator, { siteSourceId: siteId }, { page: 1, limit: 50, offset: 0 });
		expect(listed.total).toBeGreaterThan(0);
		const groups = await listSiteAuditFindingGroups(
			operator,
			{ siteSourceId: siteId },
			{ page: 1, limit: 50, offset: 0 },
		);
		expect(groups.total).toBeGreaterThan(0);
		await getSiteAuditFinding(operator, listed.rows[0].id);

		const findings = await db
			.select()
			.from(geoSiteAuditFindings)
			.where(and(eq(geoSiteAuditFindings.siteSourceId, siteId), eq(geoSiteAuditFindings.status, "OPEN")));
		expect(findings.length).toBeGreaterThan(0);
		const finding = findings[0];
		const { tasks } = await createTasksFromFindings(operator, { findingIds: [finding.id], mode: "PER_FINDING" });
		expect(tasks).toEqual([expect.objectContaining({ created: true, findingIds: [finding.id] })]);
		const [after] = await db
			.select()
			.from(geoSiteAuditFindings)
			.where(inArray(geoSiteAuditFindings.id, [finding.id]));
		expect(after).toMatchObject({ status: "TASKED", taskId: tasks[0]?.id });
	});

	it("finds no stranded work for this site in the periodic tick", async () => {
		jobs.length = 0;
		await tickSiteSchedules(deps);
		expect(jobs.filter((job) => job.data.organizationId === organizationId)).toEqual([]);
		jobs.length = 0;
	});
});
