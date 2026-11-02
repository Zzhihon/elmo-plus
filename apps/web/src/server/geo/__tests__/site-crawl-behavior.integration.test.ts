import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { GEO_QUEUE, type GeoPrincipal } from "@workspace/geo-domain";
import { FsObjectStore } from "@workspace/geo-evidence";
import { safeFetch } from "@workspace/geo-site-ingestion";
import {
	createCrawlRun,
	normalizeSiteVersion,
	parseCrawlItem,
	processCrawlRun,
	reparseSitePage,
	type SiteJobDeps,
	tickSiteSchedules,
} from "@workspace/geo-site-ingestion/store";
import { db } from "@workspace/lib/db/db";
import {
	geoOptimizationTasks,
	geoSiteCrawlItems,
	geoSiteCrawlRuns,
	geoSiteHostThrottle,
	geoSitePages,
	geoSitePageVersions,
} from "@workspace/lib/db/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSite, getPageVersion, getSitePage, getSnapshotForViewing, listSitePages } from "@/server/geo/site-core";
import { createGeoOrganization } from "@/test/integration/geo-fixtures";

const failNextTask = vi.hoisted(() => ({ armed: false }));
vi.mock("@workspace/lib/geo/tasks", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@workspace/lib/geo/tasks")>();
	return {
		...actual,
		createOptimizationTask: async (...args: Parameters<typeof actual.createOptimizationTask>) => {
			if (failNextTask.armed) {
				failNextTask.armed = false;
				throw new Error("task table unavailable");
			}
			return actual.createOptimizationTask(...args);
		},
	};
});

type Handler = (response: ServerResponse) => void;
type Routes = Record<string, Handler>;

const SUFFIX = `${randomUUID().slice(0, 8)}.example-electric.test`;
const routesByHost = new Map<string, Routes>();
const events: string[] = [];
let server: Server;
let port = 0;
let objectRoot: string;

function html(body: string | Uint8Array, contentType = "text/html; charset=utf-8", status = 200): Handler {
	return (response) => {
		response.writeHead(status, { "content-type": contentType });
		response.end(body);
	};
}

function document(title: string, body = ""): string {
	return `<!doctype html><html><head><title>${title}</title></head><body><main><h1>${title}</h1>${body}</main></body></html>`;
}

function redirect(location: string, status = 301): Handler {
	return (response) => {
		response.writeHead(status, { location });
		response.end();
	};
}

const notFound = html(document("未找到"), "text/html; charset=utf-8", 404);
const noRobots = html("User-agent: *\nAllow: /\n", "text/plain");

function startServer(): Promise<void> {
	server = createServer((request, response) => {
		const host = (request.headers.host ?? "").split(":")[0];
		const url = request.url ?? "";
		events.push(`GET ${host} ${url}`);
		(routesByHost.get(host)?.[url] ?? notFound)(response);
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			port = (server.address() as AddressInfo).port;
			resolve();
		});
	});
}

function toLocal(url: string): string {
	return url.replace(/^(http:\/\/[^/:]+)\//, `$1:${port}/`);
}

function fromLocal(url: string): string {
	return url.replace(`:${port}/`, "/");
}

/** The real safe fetch with only the address and port mapped to the local server; every other check still runs. */
const localFetch: NonNullable<SiteJobDeps["fetch"]> = async (url, options) => {
	const { beforeRedirect } = options;
	const result = await safeFetch(toLocal(url), {
		...options,
		allowedPorts: [port],
		resolve: async () => [{ address: "127.0.0.1", family: 4 }],
		addressAllowed: (address) => address === "127.0.0.1",
		beforeRedirect: beforeRedirect ? (target) => beforeRedirect(fromLocal(target)) : undefined,
	});
	const redirects = result.redirects.map((hop) => ({ ...hop, from: fromLocal(hop.from), to: fromLocal(hop.to) }));
	const mapped = { ...result, url: fromLocal(result.url), finalUrl: fromLocal(result.finalUrl), redirects };
	return result.ok
		? (mapped as typeof result)
		: ({ ...mapped, blockedTarget: result.blockedTarget && fromLocal(result.blockedTarget) } as typeof result);
};

interface SentJob {
	queue: string;
	data: Record<string, unknown>;
	startAfter?: Date | number;
}

const jobs: SentJob[] = [];
const stored: string[] = [];
let deps: SiteJobDeps;
let organizationId: string;
let admin: GeoPrincipal;
let operator: GeoPrincipal;

async function drain(): Promise<void> {
	for (let round = 0; round < 200; round++) {
		const job = jobs.shift();
		if (!job) return;
		const data = job.data as {
			organizationId: string;
			runId: string;
			itemId: string;
			versionId: string;
			reparse?: { pageId: string; versionId?: string | null; profileVersion?: number | null };
		};
		if (job.queue === GEO_QUEUE.siteCrawl) await processCrawlRun(deps, data);
		else if (job.queue === GEO_QUEUE.siteParse && data.reparse) {
			await reparseSitePage(deps, { organizationId: data.organizationId, ...data.reparse });
		} else if (job.queue === GEO_QUEUE.siteParse) await parseCrawlItem(deps, data);
		else if (job.queue === GEO_QUEUE.siteNormalize) await normalizeSiteVersion(deps, data);
	}
	throw new Error("site jobs kept coming");
}

async function newSite(hosts: Record<string, Routes>, profile: Record<string, unknown> = {}) {
	const unique = randomUUID().slice(0, 8);
	const names = Object.keys(hosts).map((host) => `${host}-${unique}.${SUFFIX}`);
	Object.values(hosts).forEach((routes, index) => {
		routesByHost.set(names[index], routes);
	});
	const base = `http://${names[0]}/`;
	const site = await createSite(admin, {
		baseUrl: base,
		allowedHosts: names,
		seedUrls: [base],
		profile: { id: "example-electric", version: 1, categories: [], ...profile },
	});
	return { id: site.id, base, hosts: names };
}

async function createRun(siteId: string) {
	const { run } = await db.transaction((tx) =>
		createCrawlRun(tx, operator, { siteSourceId: siteId, mode: "FULL", trigger: "MANUAL" }),
	);
	return run;
}

async function crawl(siteId: string) {
	const run = await createRun(siteId);
	jobs.push({ queue: GEO_QUEUE.siteCrawl, data: { organizationId, runId: run.id } });
	await drain();
	const [after] = await db.select().from(geoSiteCrawlRuns).where(eq(geoSiteCrawlRuns.id, run.id));
	return after;
}

async function pageAt(siteId: string, url: string) {
	const [row] = await db
		.select()
		.from(geoSitePages)
		.where(and(eq(geoSitePages.siteSourceId, siteId), eq(geoSitePages.normalizedUrl, url)));
	return row;
}

async function itemOf(runId: string, url: string) {
	const [row] = await db
		.select()
		.from(geoSiteCrawlItems)
		.where(and(eq(geoSiteCrawlItems.runId, runId), eq(geoSiteCrawlItems.url, url)));
	return row;
}

async function versionsOf(pageId: string) {
	return db.select().from(geoSitePageVersions).where(eq(geoSitePageVersions.pageId, pageId));
}

async function reviewTasksOf(pageId: string) {
	return db
		.select()
		.from(geoOptimizationTasks)
		.where(
			and(
				eq(geoOptimizationTasks.organizationId, organizationId),
				eq(geoOptimizationTasks.sourceRef, `site-page-unavailable:${pageId}`),
			),
		);
}

function requestsTo(prefix: string): string[] {
	return events.filter((event) => event.startsWith(`GET ${prefix}`));
}

beforeAll(async () => {
	objectRoot = await mkdtemp(path.join(tmpdir(), "geo-site-behavior-"));
	vi.stubEnv("GEO_OBJECT_STORE_URL", `file://${objectRoot}`);
	await startServer();
	const store = new FsObjectStore(objectRoot);
	const objectStore: SiteJobDeps["objectStore"] = Object.create(store, {
		put: {
			value: (...args: Parameters<typeof store.put>) => {
				stored.push(args[0]);
				return store.put(...args);
			},
		},
	});
	deps = {
		db,
		objectStore,
		send: async (queue, data, options) => {
			jobs.push({ queue, data: data as Record<string, unknown>, startAfter: options?.startAfter });
			return randomUUID();
		},
		fetch: localFetch,
		sleep: async (ms) => {
			events.push(`sleep ${ms > 0 ? "positive" : "none"}`);
		},
		workerId: "integration-test",
	};
	const org = await createGeoOrganization();
	organizationId = org.organizationId;
	admin = await org.actor(["platform_admin"]);
	operator = await org.actor(["geo_operator"]);
});

beforeEach(() => {
	events.length = 0;
	jobs.length = 0;
	stored.length = 0;
});

afterAll(async () => {
	server.closeAllConnections();
	await new Promise((resolve) => server.close(resolve));
	await rm(objectRoot, { recursive: true, force: true });
});

describe("directory pages that redirect to a trailing slash", () => {
	it("are crawled as one live page, with relative links resolved against the address that answered", async () => {
		const site = await newSite({
			www: {
				"/robots.txt": noRobots,
				"/": html(document("首页", '<a href="/news">新闻</a>')),
				"/news": redirect("/news/"),
				"/news/": html(document("新闻", '<a href="item">详情</a><img src="cover.png" alt="封面">')),
				"/news/item": html(document("详情")),
			},
		});
		const run = await crawl(site.id);
		expect(run.status).toBe("SUCCEEDED");

		const news = await pageAt(site.id, `${site.base}news`);
		expect(news).toMatchObject({ status: "ACTIVE", httpStatus: 200, canonicalUrl: null });
		expect(await pageAt(site.id, `${site.base}news/item`)).toMatchObject({ status: "ACTIVE" });
		expect(
			requestsTo(site.hosts[0]).filter((event) => event.endsWith("/news") || event.endsWith("/news/")),
		).toHaveLength(2);

		const [version] = await versionsOf(news.id);
		expect(version.fetchedUrl).toBe(`${site.base}news/`);
		expect((version.parsed as { images: string[] }).images).toEqual([`${site.base}news/cover.png`]);
	});

	it("take a separate turn on the host's rate limit for the redirect hop", async () => {
		const site = await newSite({
			www: {
				"/robots.txt": noRobots,
				"/": redirect("/home/"),
				"/home/": html(document("首页")),
			},
		});
		await crawl(site.id);
		const first = events.findIndex((event) => event.endsWith(`${site.hosts[0]} /`));
		const second = events.findIndex((event) => event.endsWith(`${site.hosts[0]} /home/`));
		expect(first).toBeGreaterThanOrEqual(0);
		expect(events.slice(first, second)).toContain("sleep positive");
	});
});

describe("pages that declare their encoding only in the document", () => {
	const GBK_TITLE = Uint8Array.from([0xca, 0xbe, 0xc0, 0xfd, 0xb5, 0xe7, 0xc6, 0xf8]);

	it("reach parsing and the snapshot view as real Chinese, not mojibake", async () => {
		const body = Buffer.concat([
			Buffer.from('<html><head><meta http-equiv="Content-Type" content="text/html; charset=gb2312"><title>'),
			GBK_TITLE,
			Buffer.from("</title></head><body><main><h1>"),
			GBK_TITLE,
			Buffer.from("</h1></main></body></html>"),
		]);
		const site = await newSite({
			www: {
				"/robots.txt": noRobots,
				"/": html(document("首页", '<a href="/gbk">x</a>')),
				"/gbk": html(body, "text/html"),
			},
		});
		await crawl(site.id);
		const page = await pageAt(site.id, `${site.base}gbk`);
		const [version] = await versionsOf(page.id);
		expect(version.title).toBe("示例电气");
		const snapshot = await getSnapshotForViewing(operator, version.id);
		expect(snapshot.html).toContain("示例电气");
	});
});

describe("content that changes back to an earlier state", () => {
	it("returns to its own version without minting another, everywhere the page is shown", async () => {
		let content = document("A 内容", "<p>第一版</p>");
		const site = await newSite({
			www: { "/robots.txt": noRobots, "/": (response) => html(content)(response) },
		});
		const home = () => pageAt(site.id, site.base);

		const first = await crawl(site.id);
		expect((await itemOf(first.id, site.base)).outcome).toBe("NEW_VERSION");
		const a = (await home()).currentVersionId;
		const uploadsOfA = stored.length;

		content = document("B 内容", "<p>第二版</p>");
		const second = await crawl(site.id);
		expect((await itemOf(second.id, site.base)).outcome).toBe("NEW_VERSION");
		const b = (await home()).currentVersionId;
		expect(b).not.toBe(a);

		content = document("A 内容", "<p>第一版</p>");
		stored.length = 0;
		const third = await crawl(site.id);
		const reverted = await itemOf(third.id, site.base);
		expect(reverted).toMatchObject({ outcome: "REVERTED", versionId: a });
		expect(stored).toEqual([]);
		expect(uploadsOfA).toBeGreaterThan(0);
		expect(await versionsOf((await home()).id)).toHaveLength(2);
		expect((await home()).currentVersionId).toBe(a);

		const { rows } = await listSitePages(operator, { siteId: site.id }, { page: 1, limit: 50, offset: 0 });
		expect(rows.find((row) => row.url === site.base)).toMatchObject({
			currentVersionId: a,
			title: "A 内容",
			versionCount: 2,
		});
		const detail = await getSitePage(operator, (await home()).id);
		expect(detail.page.currentVersionId).toBe(a);
		const shown = await getPageVersion(operator, (await home()).id, a as string);
		expect(shown.compareTo?.id).toBe(b);

		const fourth = await crawl(site.id);
		expect((await itemOf(fourth.id, site.base)).outcome).toBe("UNCHANGED");
		expect(await versionsOf((await home()).id)).toHaveLength(2);
		expect(fourth.status).toBe("SUCCEEDED");
		expect((fourth.counts as { summary: { unchanged: number } }).summary.unchanged).toBe(1);
		expect((third.counts as { summary: { reverted: number; succeeded: number } }).summary).toMatchObject({
			reverted: 1,
			succeeded: 1,
		});
	});

	it("does not let a parse of older content, finishing late, displace what the page serves now", async () => {
		let content = document("旧内容");
		const site = await newSite({ www: { "/robots.txt": noRobots, "/": (response) => html(content)(response) } });
		const run = await createRun(site.id);
		jobs.push({ queue: GEO_QUEUE.siteCrawl, data: { organizationId, runId: run.id } });
		const job = jobs.shift() as SentJob;
		await processCrawlRun(deps, job.data as { organizationId: string; runId: string });
		const lateParse = jobs.splice(0).find((entry) => entry.queue === GEO_QUEUE.siteParse) as SentJob;

		content = document("新内容");
		await crawl(site.id);
		const page = await pageAt(site.id, site.base);
		await parseCrawlItem(deps, lateParse.data as { organizationId: string; itemId: string });
		const [current] = await versionsOf(page.id).then((rows) => rows.filter((row) => row.id === page.currentVersionId));
		expect(current.title).toBe("新内容");
		expect((await pageAt(site.id, site.base)).currentVersionId).toBe(page.currentVersionId);
	});
});

describe("pages that go away or move", () => {
	it("raises the review item even when the first attempt fails partway, and only once", async () => {
		const routes: Routes = {
			"/robots.txt": noRobots,
			"/": html(document("首页", '<a href="/retired">产品</a>')),
			"/retired": html(document("旧产品")),
		};
		const site = await newSite({ www: routes });
		await crawl(site.id);
		const url = `${site.base}retired`;
		const page = await pageAt(site.id, url);
		expect(await versionsOf(page.id)).toHaveLength(1);

		routes["/retired"] = notFound;
		failNextTask.armed = true;
		const run = await createRun(site.id);
		await expect(processCrawlRun(deps, { organizationId, runId: run.id })).rejects.toThrow("task table unavailable");
		expect((await pageAt(site.id, url)).status).toBe("ACTIVE");
		await drain();

		await processCrawlRun(deps, { organizationId, runId: run.id });
		await drain();
		expect((await pageAt(site.id, url)).status).toBe("GONE");
		expect(await reviewTasksOf(page.id)).toHaveLength(1);

		await crawl(site.id);
		expect(await reviewTasksOf(page.id)).toHaveLength(1);
	});

	it.each(["ERROR", "BLOCKED"] as const)(
		"treats a page last seen as %s as live when it then disappears",
		async (status) => {
			const routes: Routes = {
				"/robots.txt": noRobots,
				"/": html(document("首页", '<a href="/flaky">产品</a>')),
				"/flaky": html(document("偶发故障")),
			};
			const site = await newSite({ www: routes });
			await crawl(site.id);
			const page = await pageAt(site.id, `${site.base}flaky`);
			await db.update(geoSitePages).set({ status }).where(eq(geoSitePages.id, page.id));

			routes["/flaky"] = notFound;
			await crawl(site.id);
			expect(await reviewTasksOf(page.id)).toHaveLength(1);
		},
	);

	it("raises one for a redirect off the allowlist, which it refuses to follow", async () => {
		const routes: Routes = {
			"/robots.txt": noRobots,
			"/": html(document("首页", '<a href="/product">产品</a>')),
			"/product": html(document("产品")),
		};
		const site = await newSite({ www: routes });
		await crawl(site.id);
		const url = `${site.base}product`;
		const page = await pageAt(site.id, url);

		routes["/product"] = redirect("http://user:secret@elsewhere.example-other.test/new", 302);
		const run = await crawl(site.id);
		expect(await itemOf(run.id, url)).toMatchObject({ status: "FAILED", outcome: "REDIRECT_BLOCKED" });
		const after = await pageAt(site.id, url);
		expect(after.status).toBe("REDIRECTED");
		expect(after.canonicalUrl).toBe("http://elsewhere.example-other.test/new");
		expect(requestsTo("elsewhere")).toEqual([]);
		const tasks = await reviewTasksOf(page.id);
		expect(tasks).toHaveLength(1);
		expect(await versionsOf(page.id)).toHaveLength(1);
	});
});

describe("one executor per crawl run", () => {
	it("makes a second job for the same run leave it alone while the first is working", async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let entered: () => void = () => {};
		const inFlight = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const site = await newSite({
			www: {
				"/robots.txt": noRobots,
				"/": html(document("首页", '<a href="/a">a</a><a href="/b">b</a>')),
				"/a": html(document("甲")),
				"/b": html(document("乙")),
			},
		});
		const run = await createRun(site.id);
		const blocking: SiteJobDeps = {
			...deps,
			fetch: async (url, options) => {
				entered();
				await gate;
				return localFetch(url, options);
			},
		};
		const first = processCrawlRun(blocking, { organizationId, runId: run.id });
		await inFlight;
		const second = await processCrawlRun(deps, { organizationId, runId: run.id });
		expect(second).toMatchObject({ continued: false, processed: 0 });
		release();
		expect(await first).toMatchObject({ status: "SUCCEEDED" });

		const [after] = await db.select().from(geoSiteCrawlRuns).where(eq(geoSiteCrawlRuns.id, run.id));
		expect(after.leaseHolder).toBeNull();
		for (const route of ["/robots.txt", "/", "/a", "/b"]) {
			expect(requestsTo(`${site.hosts[0]} ${route}`).filter((e) => e.endsWith(` ${route}`))).toHaveLength(1);
		}
	});

	it("lets another job take over once the holder's lease has lapsed, and picks up what it was fetching", async () => {
		const site = await newSite({ www: { "/robots.txt": noRobots, "/": html(document("首页")) } });
		const run = await createRun(site.id);
		await db.insert(geoSiteCrawlItems).values({
			organizationId,
			runId: run.id,
			url: `${site.base}`,
			source: "SEED",
			status: "FETCHING",
		});
		await db
			.update(geoSiteCrawlRuns)
			.set({
				status: "RUNNING",
				leaseHolder: "dead-worker",
				leaseUntil: sql`now() + interval '5 minutes'`,
				counts: {
					meta: {
						robots: { source: "NOT_FOUND", httpStatus: 404, crawlDelaySeconds: null, sitemaps: [], ruleCount: 0 },
					},
				},
			})
			.where(eq(geoSiteCrawlRuns.id, run.id));

		expect(await processCrawlRun(deps, { organizationId, runId: run.id })).toMatchObject({ processed: 0 });
		expect((await itemOf(run.id, site.base)).status).toBe("FETCHING");

		await db
			.update(geoSiteCrawlRuns)
			.set({ leaseUntil: sql`now() - interval '1 second'` })
			.where(eq(geoSiteCrawlRuns.id, run.id));
		expect(await processCrawlRun(deps, { organizationId, runId: run.id })).toMatchObject({ status: "SUCCEEDED" });
		expect((await itemOf(run.id, site.base)).status).toBe("DONE");
		jobs.length = 0;
	});

	it("resends a stalled run only after its lease lapses", async () => {
		const site = await newSite({ www: { "/robots.txt": noRobots, "/": html(document("首页")) } });
		const run = await createRun(site.id);
		await db
			.update(geoSiteCrawlRuns)
			.set({
				status: "RUNNING",
				startedAt: sql`now() - interval '1 hour'`,
				leaseHolder: "worker",
				leaseUntil: sql`now() + interval '5 minutes'`,
			})
			.where(eq(geoSiteCrawlRuns.id, run.id));
		const sentFor = () => jobs.filter((job) => job.data.runId === run.id);

		await tickSiteSchedules(deps);
		expect(sentFor()).toEqual([]);

		await db
			.update(geoSiteCrawlRuns)
			.set({ leaseUntil: sql`now() - interval '1 second'` })
			.where(eq(geoSiteCrawlRuns.id, run.id));
		await tickSiteSchedules(deps);
		expect(sentFor()).toHaveLength(1);
		await db.update(geoSiteCrawlRuns).set({ status: "CANCELLED" }).where(eq(geoSiteCrawlRuns.id, run.id));
	});

	it("allows one active run per source however many start at once", async () => {
		const site = await newSite({ www: { "/robots.txt": noRobots } });
		const results = await Promise.all(
			Array.from({ length: 5 }, () =>
				db.transaction((tx) => createCrawlRun(tx, operator, { siteSourceId: site.id, mode: "FULL" })),
			),
		);
		expect(results.filter((result) => result.created)).toHaveLength(1);
		expect(new Set(results.map((result) => result.run.id)).size).toBe(1);
		await db.update(geoSiteCrawlRuns).set({ status: "CANCELLED" }).where(eq(geoSiteCrawlRuns.id, results[0].run.id));
	});
});

describe("a long Crawl-delay", () => {
	it("hands the worker and the host lease back and comes back when the host may be asked again", async () => {
		const site = await newSite({
			www: {
				"/robots.txt": html("User-agent: *\nCrawl-delay: 86400\n", "text/plain"),
				"/": html(document("首页", '<a href="/a">a</a>')),
				"/a": html(document("甲")),
			},
		});
		const run = await createRun(site.id);
		const host = site.hosts[0];
		const before = Date.now();
		const chunk = await processCrawlRun(deps, { organizationId, runId: run.id });
		expect(chunk).toMatchObject({ status: "RUNNING", continued: true });

		const again = jobs.filter((job) => job.queue === GEO_QUEUE.siteCrawl).at(-1) as SentJob;
		const startAfter = (again.startAfter as Date).getTime();
		expect(startAfter).toBeGreaterThan(before + 60_000);
		expect(startAfter).toBeLessThan(before + 400_000);

		const [throttle] = await db.select().from(geoSiteHostThrottle).where(eq(geoSiteHostThrottle.host, host));
		expect(throttle).toMatchObject({ holder: null, leaseUntil: null });
		const [state] = await db.select().from(geoSiteCrawlRuns).where(eq(geoSiteCrawlRuns.id, run.id));
		expect(state.leaseHolder).toBeNull();
		expect(requestsTo(`${host} /a`)).toEqual([]);

		await db.update(geoSiteHostThrottle).set({ nextAllowedAt: sql`now()` }).where(eq(geoSiteHostThrottle.host, host));
		const fetchedBefore = requestsTo(host).length;
		jobs.length = 0;
		await processCrawlRun(deps, { organizationId, runId: run.id });
		expect(requestsTo(host).length).toBe(fetchedBefore + 1);
		await db.update(geoSiteCrawlRuns).set({ status: "CANCELLED" }).where(eq(geoSiteCrawlRuns.id, run.id));
	});
});

describe("robots.txt", () => {
	it("keeps every rule across chunks and reads the file once a run", async () => {
		const rules = Array.from({ length: 600 }, (_, index) => `Disallow: /secret-${index}\n`).join("");
		const site = await newSite({
			www: {
				"/robots.txt": html(`User-agent: *\n${rules}`, "text/plain"),
				"/": html(document("首页", '<a href="/open">公开</a><a href="/secret-550">内部</a>')),
				"/open": html(document("公开")),
				"/secret-550": html(document("内部")),
			},
		});
		const run = await createRun(site.id);
		const pausingDeps: SiteJobDeps = {
			...deps,
			fetch: async (url, options) => {
				const result = await localFetch(url, options);
				if (url === site.base) {
					await db.update(geoSiteCrawlRuns).set({ status: "PAUSED" }).where(eq(geoSiteCrawlRuns.id, run.id));
				}
				return result;
			},
		};
		expect(await processCrawlRun(pausingDeps, { organizationId, runId: run.id })).toMatchObject({ status: "PAUSED" });

		await db.update(geoSiteCrawlRuns).set({ status: "QUEUED" }).where(eq(geoSiteCrawlRuns.id, run.id));
		jobs.push({ queue: GEO_QUEUE.siteCrawl, data: { organizationId, runId: run.id } });
		await drain();

		const host = site.hosts[0];
		expect(requestsTo(`${host} /secret-550`)).toEqual([]);
		expect(requestsTo(`${host} /robots.txt`)).toHaveLength(1);
		expect(await itemOf(run.id, `${site.base}secret-550`)).toMatchObject({ outcome: "ROBOTS_DISALLOWED" });
		const [after] = await db.select().from(geoSiteCrawlRuns).where(eq(geoSiteCrawlRuns.id, run.id));
		const stored = after.robots as Record<string, { rules: unknown[] }>;
		expect(stored[new URL(site.base).origin].rules).toHaveLength(600);
		expect(JSON.stringify(after.counts)).not.toContain("secret-550");
	});

	it("answers for its own host: each allowed host is held to its own file", async () => {
		const site = await newSite({
			www: {
				"/robots.txt": html("User-agent: *\nDisallow: /only-www-forbids\n", "text/plain"),
				"/": html(document("首页")),
			},
			cdn: {
				"/robots.txt": html("User-agent: *\nDisallow: /private\n", "text/plain"),
				"/open": html(document("开放")),
				"/only-www-forbids": html(document("仅主站禁止")),
				"/private": html(document("私有")),
				"/moved-in": html(document("目标")),
			},
		});
		const [www, cdn] = site.hosts;
		routesByHost.set(www, {
			...routesByHost.get(www),
			"/": html(
				document(
					"首页",
					`<a href="http://${cdn}/open">a</a><a href="http://${cdn}/only-www-forbids">b</a><a href="http://${cdn}/private">c</a>`,
				),
			),
		});
		const run = await crawl(site.id);
		expect(requestsTo(`${cdn} /robots.txt`)).toHaveLength(1);
		expect(requestsTo(`${cdn} /open`)).toHaveLength(1);
		expect(requestsTo(`${cdn} /only-www-forbids`)).toHaveLength(1);
		expect(requestsTo(`${cdn} /private`)).toEqual([]);
		expect(await itemOf(run.id, `http://${cdn}/private`)).toMatchObject({ outcome: "ROBOTS_DISALLOWED" });
	});

	it("skips a host whose own file cannot be read, without failing the rest of the run", async () => {
		const site = await newSite({
			www: { "/robots.txt": noRobots, "/": html(document("首页")) },
			cdn: { "/robots.txt": html("故障", "text/plain", 503), "/x": html(document("x")) },
		});
		const [www, cdn] = site.hosts;
		routesByHost.set(www, { ...routesByHost.get(www), "/": html(document("首页", `<a href="http://${cdn}/x">x</a>`)) });
		const run = await crawl(site.id);
		expect(run.status).toBe("SUCCEEDED");
		expect(requestsTo(`${cdn} /x`)).toEqual([]);
		expect(await itemOf(run.id, `http://${cdn}/x`)).toMatchObject({ status: "SKIPPED", outcome: "ROBOTS_DISALLOWED" });
	});

	it("is checked for a redirect's target, and a page sent somewhere forbidden has moved", async () => {
		const routes: Routes = {
			"/robots.txt": html("User-agent: *\nDisallow: /forbidden/\nDisallow: /section/\n", "text/plain"),
			"/": html(document("首页", '<a href="/product">产品</a><a href="/section">栏目</a>')),
			"/product": html(document("产品")),
			"/section": redirect("/section/"),
			"/section/": html(document("栏目")),
			"/forbidden/new": html(document("禁止")),
		};
		const site = await newSite({ www: routes });
		await crawl(site.id);
		const host = site.hosts[0];
		expect(requestsTo(`${host} /section/`)).toEqual([]);
		const product = await pageAt(site.id, `${site.base}product`);

		routes["/product"] = redirect("/forbidden/new");
		const run = await crawl(site.id);
		expect(requestsTo(`${host} /forbidden/new`)).toEqual([]);
		expect(await itemOf(run.id, `${site.base}product`)).toMatchObject({
			status: "SKIPPED",
			outcome: "ROBOTS_DISALLOWED",
		});
		expect((await pageAt(site.id, `${site.base}product`)).status).toBe("REDIRECTED");
		expect(await reviewTasksOf(product.id)).toHaveLength(1);
		expect(await itemOf(run.id, `${site.base}section`)).toMatchObject({ outcome: "ROBOTS_DISALLOWED" });
		const pages = await db
			.select()
			.from(geoSitePages)
			.where(inArray(geoSitePages.normalizedUrl, [`${site.base}section`]));
		expect(pages.every((page) => page.status !== "REDIRECTED")).toBe(true);
	});
});

describe("attachments", () => {
	it("stores one whose name is not valid percent-encoding", async () => {
		const site = await newSite(
			{
				www: {
					"/robots.txt": noRobots,
					"/": html(document("首页", '<a href="/files/100%off.pdf">样本</a>')),
					"/files/100%off.pdf": html("%PDF-1.4", "application/pdf"),
				},
			},
			{ assets: { download: true, extensions: [".pdf"], mimeTypes: ["application/pdf"], maxCount: 5 } },
		);
		const run = await crawl(site.id);
		expect(run.status).toBe("SUCCEEDED");
		const url = `${site.base}files/100%off.pdf`;
		expect(await itemOf(run.id, url)).toMatchObject({ outcome: "ASSET_STORED" });
		const page = await pageAt(site.id, url);
		const [version] = await versionsOf(page.id);
		expect(version.title).toBe("100%off.pdf");
		expect(page.currentVersionId).toBe(version.id);
	});
});
