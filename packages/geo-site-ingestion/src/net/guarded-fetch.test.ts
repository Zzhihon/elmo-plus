import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkEndpointReachable, checkEndpointUrl, createGuardedFetch, GuardedFetchError } from "./guarded-fetch";

const HOST = "model-api.example-vendor.test";

describe("guarded fetch against a real socket", () => {
	let server: Server;
	let port: number;
	const received: { method?: string; url?: string; auth?: string; body: string }[] = [];

	function handle(req: IncomingMessage, res: ServerResponse) {
		let body = "";
		req.on("data", (chunk) => {
			body += chunk;
		});
		req.on("end", () => {
			received.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
			if (req.url === "/moved") {
				res.writeHead(302, { Location: `http://${HOST}:${port}/elsewhere` }).end();
			} else if (req.url === "/big") {
				res.writeHead(200).end("x".repeat(64));
			} else {
				res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
			}
		});
	}

	beforeAll(async () => {
		server = createServer(handle);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		port = (server.address() as AddressInfo).port;
	});
	afterAll(() => new Promise((resolve) => server.close(resolve)));

	const local = () => ({
		resolve: async () => [{ address: "127.0.0.1", family: 4 as const }],
		addressAllowed: () => true,
		allowedPorts: [port],
	});

	it("sends the method, headers and body of an API call, including under /api paths the crawler avoids", async () => {
		const fetchImpl = createGuardedFetch(local());
		const response = await fetchImpl(`http://${HOST}:${port}/api/v3/chat`, {
			method: "POST",
			headers: { Authorization: "Bearer key-1", "Content-Type": "application/json" },
			body: JSON.stringify({ q: "问题" }),
		});
		expect(await response.json()).toEqual({ ok: true });
		expect(received.at(-1)).toEqual({
			method: "POST",
			url: "/api/v3/chat",
			auth: "Bearer key-1",
			body: JSON.stringify({ q: "问题" }),
		});
	});

	it("never connects when the host resolves to a private address, so the credential goes nowhere", async () => {
		const before = received.length;
		const fetchImpl = createGuardedFetch({
			resolve: async () => [{ address: "10.1.2.3", family: 4 }],
			allowedPorts: [port],
		});
		await expect(
			fetchImpl(`http://${HOST}:${port}/v1/models`, { headers: { Authorization: "Bearer key-1" } }),
		).rejects.toMatchObject({ code: "ADDRESS_BLOCKED" });
		expect(received.length).toBe(before);
	});

	it("refuses when only one of several answers is private", async () => {
		const fetchImpl = createGuardedFetch({
			resolve: async () => [
				{ address: "93.184.216.34", family: 4 },
				{ address: "169.254.169.254", family: 4 },
			],
			allowedPorts: [port],
		});
		await expect(fetchImpl(`http://${HOST}:${port}/v1/models`)).rejects.toBeInstanceOf(GuardedFetchError);
	});

	it("treats a redirect as an error instead of carrying the credential to the next address", async () => {
		const fetchImpl = createGuardedFetch(local());
		await expect(
			fetchImpl(`http://${HOST}:${port}/moved`, { headers: { Authorization: "Bearer key-1" } }),
		).rejects.toMatchObject({ code: "TOO_MANY_REDIRECTS" });
		expect(received.some((entry) => entry.url === "/elsewhere")).toBe(false);
	});

	it("cuts off an answer over the size limit", async () => {
		const fetchImpl = createGuardedFetch({ ...local(), maxBytes: 16 });
		await expect(fetchImpl(`http://${HOST}:${port}/big`)).rejects.toMatchObject({ code: "TOO_LARGE" });
	});

	it("rejects with the caller's reason when its signal fires, even while DNS hangs", async () => {
		const fetchImpl = createGuardedFetch({ ...local(), resolve: () => new Promise(() => {}) });
		await expect(fetchImpl(`http://${HOST}:${port}/x`, { signal: AbortSignal.timeout(20) })).rejects.toMatchObject({
			name: "TimeoutError",
		});
	});
});

describe("endpoint checks before anything is sent", () => {
	it.each([
		["https://10.0.0.8/v1", "IP_LITERAL"],
		["https://[::1]/v1", "IP_LITERAL"],
		["https://2130706433/v1", "IP_LITERAL"],
		["https://internal.example-vendor.test:8443/v1", "PORT"],
		["https://user:pw@api.example-vendor.test/v1", "CREDENTIALS"],
	])("refuses %s from the URL alone", (url, reason) => {
		expect(checkEndpointUrl(url)).toEqual({ ok: false, reason });
	});

	it("allows an ordinary API path on a named host", () => {
		expect(checkEndpointUrl("https://api.example-vendor.test/api/v3")).toEqual({ ok: true });
	});

	it("looks at what the host resolves to right now", async () => {
		const url = "https://api.example-vendor.test/v1";
		await expect(
			checkEndpointReachable(url, { resolve: async () => [{ address: "192.168.1.5", family: 4 }] }),
		).resolves.toMatchObject({ ok: false, code: "ADDRESS_BLOCKED" });
		await expect(
			checkEndpointReachable(url, { resolve: async () => [{ address: "93.184.216.34", family: 4 }] }),
		).resolves.toEqual({ ok: true });
		await expect(
			checkEndpointReachable(url, {
				resolve: async () => {
					throw new Error("NXDOMAIN");
				},
			}),
		).resolves.toMatchObject({ ok: false, code: "DNS_FAILED" });
	});
});
