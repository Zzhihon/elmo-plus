import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { isPublicAddress } from "./address";
import { isAllowedByRobots, parseRobots, robotsFromStatus } from "./robots";
import { type Resolver, type SafeFetchOptions, safeFetch } from "./safe-fetch";
import { checkUrl } from "./url-policy";

const SITE = "www.example-electric.test";
const OTHER = "cdn.example-electric.test";

describe("isPublicAddress", () => {
	it.each([
		"127.0.0.1",
		"10.1.2.3",
		"172.20.0.1",
		"192.168.1.1",
		"169.254.169.254",
		"100.64.0.1",
		"0.0.0.0",
		"224.0.0.1",
		"::1",
		"::",
		"fe80::1",
		"fd00:ec2::254",
		"::ffff:127.0.0.1",
		"::ffff:7f00:1",
		"::ffff:a9fe:a9fe",
		"64:ff9b::a9fe:a9fe",
		"2002:7f00:1::",
		"not-an-ip",
	])("refuses %s", (address) => {
		expect(isPublicAddress(address)).toBe(false);
	});

	it.each(["93.184.216.34", "1.1.1.1", "2606:4700:4700::1111"])("accepts %s", (address) => {
		expect(isPublicAddress(address)).toBe(true);
	});
});

describe("checkUrl", () => {
	const policy = { allowedHosts: [SITE], exclude: ["^/download/"] };

	it.each([
		["file:///etc/passwd", "PROTOCOL"],
		["javascript:alert(1)", "PROTOCOL"],
		["ftp://www.example-electric.test/", "PROTOCOL"],
		["gopher://www.example-electric.test/", "PROTOCOL"],
		["http://user:pass@www.example-electric.test/", "CREDENTIALS"],
		["http://www.example-electric.test:8080/", "PORT"],
		["http://127.0.0.1/", "IP_LITERAL"],
		["http://[::1]/", "IP_LITERAL"],
		["http://169.254.169.254/latest/meta-data/", "IP_LITERAL"],
		["http://example-electric.test/", "HOST_NOT_ALLOWED"],
		["http://www.example-electric.test.attacker.test/", "HOST_NOT_ALLOWED"],
		["http://www-example-electric.test/", "HOST_NOT_ALLOWED"],
		["http://www.example-electric.test/admin/index.html", "SENSITIVE_PATH"],
		["http://www.example-electric.test/login.html", "SENSITIVE_PATH"],
		["http://www.example-electric.test/.git/config", "SENSITIVE_PATH"],
		["http://www.example-electric.test/download/a.html", "EXCLUDED"],
	])("refuses %s as %s", (url, reason) => {
		const decision = checkUrl(url, policy);
		expect(decision.ok).toBe(false);
		if (!decision.ok) expect(decision.reason).toBe(reason);
	});

	it("accepts an in-scope page and normalizes it", () => {
		const decision = checkUrl("HTTP://WWW.Example-Electric.test:80/products/?utm_source=x#top", policy);
		expect(decision).toEqual({ ok: true, url: "http://www.example-electric.test/products", host: SITE });
	});

	it("only accepts what an include rule names when one is set", () => {
		const scoped = { allowedHosts: [SITE], include: ["^/products"] };
		expect(checkUrl("http://www.example-electric.test/products/a.html", scoped).ok).toBe(true);
		expect(checkUrl("http://www.example-electric.test/jobs.html", scoped)).toMatchObject({ reason: "NOT_INCLUDED" });
	});
});

describe("robots policy", () => {
	it("takes the longest matching rule and lets allow win a tie", () => {
		const robots = parseRobots(
			"User-agent: *\nDisallow: /private\nAllow: /private/public\nDisallow: /*.pdf$\nSitemap: http://www.example-electric.test/s.xml",
			"ElmoGeoSiteIngestion",
		);
		expect(isAllowedByRobots(robots, "/private/x.html")).toBe(false);
		expect(isAllowedByRobots(robots, "/private/public/x.html")).toBe(true);
		expect(isAllowedByRobots(robots, "/files/a.pdf")).toBe(false);
		expect(isAllowedByRobots(robots, "/files/a.pdf?x=1")).toBe(true);
		expect(robots.sitemaps).toEqual(["http://www.example-electric.test/s.xml"]);
	});

	it("treats a missing robots.txt as no restriction and an unreachable one as full disallow", () => {
		expect(isAllowedByRobots(robotsFromStatus(404), "/anything")).toBe(true);
		expect(robotsFromStatus(404).source).toBe("NOT_FOUND");
		expect(isAllowedByRobots(robotsFromStatus(503), "/anything")).toBe(false);
		expect(isAllowedByRobots(robotsFromStatus(null), "/")).toBe(false);
	});
});

describe("safeFetch", () => {
	let server: Server;
	let port = 0;
	const hits: Array<{ url: string; host: string | undefined }> = [];
	const routes: Record<string, (req: IncomingMessage, res: ServerResponse) => void> = {
		"/page": (_req, res) => {
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			res.end("<html><title>示例电气</title></html>");
		},
		"/to-foreign": (_req, res) => {
			res.writeHead(302, { Location: "http://attacker.test/steal" });
			res.end();
		},
		"/to-metadata": (_req, res) => {
			res.writeHead(301, { Location: "http://169.254.169.254/latest/meta-data/" });
			res.end();
		},
		"/to-file": (_req, res) => {
			res.writeHead(302, { Location: "file:///etc/passwd" });
			res.end();
		},
		"/to-other-allowed": (_req, res) => {
			res.writeHead(302, { Location: `http://${OTHER}:${port}/page` });
			res.end();
		},
		"/huge": (_req, res) => {
			res.writeHead(200, { "Content-Type": "text/html" });
			res.write("x".repeat(4096));
			res.end("x".repeat(4096));
		},
		"/binary": (_req, res) => {
			res.writeHead(200, { "Content-Type": "application/octet-stream" });
			res.end("MZ");
		},
		"/slow": () => {},
	};

	beforeAll(async () => {
		server = createServer((req, res) => {
			hits.push({ url: req.url ?? "", host: req.headers.host });
			const route = routes[req.url ?? ""];
			if (route) route(req, res);
			else {
				res.writeHead(404);
				res.end();
			}
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		port = (server.address() as AddressInfo).port;
	});
	afterAll(() => {
		server.closeAllConnections();
		server.close();
	});

	const localOnly = (address: string) => address === "127.0.0.1";
	const options = (resolve: Resolver, extra: Partial<SafeFetchOptions> = {}): SafeFetchOptions => ({
		allowedHosts: [SITE, OTHER],
		allowedPorts: [port],
		userAgent: "ElmoGeoSiteIngestion/1.0 (+https://example-electric.test/contact)",
		maxBytes: 1024 * 1024,
		timeoutMs: 2000,
		allowedMimeTypes: ["text/html"],
		resolve,
		addressAllowed: localOnly,
		...extra,
	});
	const toLoopback: Resolver = async () => [{ address: "127.0.0.1", family: 4 }];

	it("connects to the address it validated and keeps the site's host name", async () => {
		const resolve = vi.fn(toLoopback);
		const result = await safeFetch(`http://${SITE}:${port}/page`, options(resolve));
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.status).toBe(200);
			expect(result.address).toBe("127.0.0.1");
		}
		expect(resolve).toHaveBeenCalledTimes(1);
		expect(hits.at(-1)).toEqual({ url: "/page", host: `${SITE}:${port}` });
	});

	it("refuses a host when any resolved address is private, without connecting", async () => {
		const before = hits.length;
		const mixed: Resolver = async () => [
			{ address: "93.184.216.34", family: 4 },
			{ address: "10.0.0.8", family: 4 },
		];
		const result = await safeFetch(`http://${SITE}:${port}/page`, options(mixed, { addressAllowed: isPublicAddress }));
		expect(result).toMatchObject({ ok: false, code: "ADDRESS_BLOCKED", blockedReason: "PRIVATE_ADDRESS" });
		expect(hits.length).toBe(before);
	});

	it("refuses a site whose name resolves to the loopback in production mode", async () => {
		const result = await safeFetch(`http://${SITE}:${port}/page`, options(toLoopback, { addressAllowed: isPublicAddress }));
		expect(result).toMatchObject({ ok: false, code: "ADDRESS_BLOCKED" });
	});

	it.each([
		["/to-foreign", "HOST_NOT_ALLOWED"],
		["/to-metadata", "IP_LITERAL"],
		["/to-file", "PROTOCOL"],
	])("blocks the redirect %s (%s) and reports where it pointed", async (path, reason) => {
		const before = hits.length;
		const result = await safeFetch(`http://${SITE}:${port}${path}`, options(toLoopback));
		expect(result).toMatchObject({ ok: false, code: "REDIRECT_BLOCKED", blockedReason: reason, status: expect.any(Number) });
		if (!result.ok) expect(result.blockedTarget).toBeTruthy();
		expect(hits.length).toBe(before + 1);
	});

	it("re-checks DNS on every hop, so an allowed host that resolves privately is refused mid-redirect", async () => {
		const resolve: Resolver = async (hostname) =>
			hostname === SITE ? [{ address: "127.0.0.1", family: 4 }] : [{ address: "10.0.0.5", family: 4 }];
		const result = await safeFetch(`http://${SITE}:${port}/to-other-allowed`, options(resolve));
		expect(result).toMatchObject({ ok: false, code: "ADDRESS_BLOCKED" });
		if (!result.ok) expect(result.redirects).toHaveLength(1);
	});

	it("refuses non-web protocols before any lookup", async () => {
		const resolve = vi.fn(toLoopback);
		const result = await safeFetch("file:///etc/passwd", options(resolve));
		expect(result).toMatchObject({ ok: false, code: "URL_REFUSED", blockedReason: "PROTOCOL" });
		expect(resolve).not.toHaveBeenCalled();
	});

	it("cuts off a body larger than the limit", async () => {
		const result = await safeFetch(`http://${SITE}:${port}/huge`, options(toLoopback, { maxBytes: 5000 }));
		expect(result).toMatchObject({ ok: false, code: "TOO_LARGE" });
	});

	it("refuses a successful answer of a type it did not ask for", async () => {
		const result = await safeFetch(`http://${SITE}:${port}/binary`, options(toLoopback));
		expect(result).toMatchObject({ ok: false, code: "MIME_REJECTED", status: 200 });
	});

	it("gives up when the whole exchange exceeds its time limit", async () => {
		const started = Date.now();
		const result = await safeFetch(`http://${SITE}:${port}/slow`, options(toLoopback, { timeoutMs: 300 }));
		expect(result).toMatchObject({ ok: false, code: "TIMEOUT" });
		expect(Date.now() - started).toBeLessThan(2000);
	});
});
