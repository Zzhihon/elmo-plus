import { resetDeploymentCache } from "@workspace/deployment";
import { GeoError } from "@workspace/geo-domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ApiAuth, OrganizationAuth } from "@/lib/auth/api-auth";
import { createGeoApiHandler, withGeoMethodGuard } from "../geo-handler";
import { apiHandlerMeta } from "../handler";

const resolveApiAuth = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/api-auth", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/auth/api-auth")>()),
	resolveApiAuth,
}));
vi.mock("@/lib/auth/server", () => ({ auth: { api: {} } }));

type Stored = { requestHash: string; status: number | null; body: unknown };
const idempotency = vi.hoisted(() => new Map<string, Stored>());
vi.mock("@workspace/lib/geo/idempotency", () => {
	const id = (scope: { organizationId: string; key: string; route: string }) =>
		`${scope.organizationId}|${scope.key}|${scope.route}`;
	return {
		claimGeoIdempotencyKey: async (_db: unknown, scope: Parameters<typeof id>[0] & { requestHash: string }) => {
			const existing = idempotency.get(id(scope));
			if (!existing) {
				idempotency.set(id(scope), { requestHash: scope.requestHash, status: null, body: null });
				return { kind: "claimed" };
			}
			if (existing.requestHash !== scope.requestHash) return { kind: "mismatch" };
			if (existing.status === null) return { kind: "in_flight" };
			return { kind: "replay", status: existing.status, body: existing.body };
		},
		completeGeoIdempotencyKey: async (
			_db: unknown,
			scope: Parameters<typeof id>[0] & { status: number; body: unknown },
		) => {
			const existing = idempotency.get(id(scope));
			if (existing) Object.assign(existing, { status: scope.status, body: scope.body });
		},
		releaseGeoIdempotencyKey: async (_db: unknown, scope: Parameters<typeof id>[0]) => {
			idempotency.delete(id(scope));
		},
	};
});

function keyAuth(overrides: Partial<OrganizationAuth> = {}): ApiAuth {
	return {
		kind: "organization",
		keyId: "key-1",
		name: "ci",
		organizationId: "org-1",
		organizationName: "示例电气",
		scopes: new Set(["read", "write"]),
		brandIds: null,
		createdAt: null,
		lastUsedAt: null,
		expiresAt: null,
		rateLimit: { limit: 60, window: "minute" },
		rateLimitRemaining: 10,
		...overrides,
	};
}

function request(init: { method?: string; body?: string; headers?: Record<string, string> } = {}) {
	return new Request("http://localhost/api/v1/geo/test", {
		method: init.method ?? "POST",
		headers: { Authorization: "Bearer key", ...init.headers },
		body: init.body,
	});
}

async function errorOf(response: Response) {
	return ((await response.json()) as { error: { code: string; message: string; request_id: string } }).error;
}

describe("createGeoApiHandler", () => {
	beforeEach(() => {
		vi.stubEnv("GEO_WORKSPACE_ENABLED", "1");
		vi.stubEnv("DEPLOYMENT_MODE", "local");
		resetDeploymentCache();
		resolveApiAuth.mockResolvedValue({ auth: keyAuth() });
		idempotency.clear();
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
		resetDeploymentCache();
	});

	it("reads as an unknown path while the workspace is off, before touching the key", async () => {
		vi.stubEnv("GEO_WORKSPACE_ENABLED", "");
		const handle = vi.fn();
		const response = await createGeoApiHandler({ permission: "sampling.run", handle })({
			request: request(),
			params: {},
		});
		expect(response.status).toBe(404);
		expect((await errorOf(response)).code).toBe("NOT_FOUND");
		expect(resolveApiAuth).not.toHaveBeenCalled();
		expect(handle).not.toHaveBeenCalled();
	});

	it("hands the handler a principal for the key's organization and stamps the request id", async () => {
		const handler = createGeoApiHandler({
			permission: "sampling.run",
			status: 201,
			handle: async ({ principal, requestId }) => ({ principal, requestId }),
		});
		const response = await handler({ request: request(), params: {} });
		expect(response.status).toBe(201);
		const body = (await response.json()) as { principal: Record<string, unknown>; requestId: string };
		expect(body.principal).toMatchObject({
			organizationId: "org-1",
			actorId: "apikey:key-1",
			actorKind: "api_key",
			roles: ["viewer", "geo_operator"],
		});
		expect(response.headers.get("X-Request-Id")).toBe(body.requestId);
	});

	it("refuses a key on a review or administration permission, however broad its scopes", async () => {
		const handle = vi.fn();
		for (const permission of ["knowledge.review", "task.review_tech", "rbac.manage", "audit.read"] as const) {
			const response = await createGeoApiHandler({ permission, handle })({ request: request(), params: {} });
			expect(response.status, permission).toBe(403);
			expect((await errorOf(response)).code).toBe("FORBIDDEN");
		}
		expect(handle).not.toHaveBeenCalled();
	});

	it("refuses a read-only key on a write in the GEO envelope", async () => {
		resolveApiAuth.mockResolvedValue({ auth: keyAuth({ scopes: new Set(["read"]) }) });
		const response = await createGeoApiHandler({ permission: "sampling.run", handle: vi.fn() })({
			request: request(),
			params: {},
		});
		expect(response.status).toBe(403);
		const error = await errorOf(response);
		expect(error.code).toBe("FORBIDDEN");
		expect(error.request_id).toBe(response.headers.get("X-Request-Id"));
	});

	it("gives a brand-narrowed key no access to organization-wide data", async () => {
		resolveApiAuth.mockResolvedValue({ auth: keyAuth({ brandIds: ["brand-1"] }) });
		const handle = vi.fn();
		const response = await createGeoApiHandler({ permission: "observation.read", handle })({
			request: request({ method: "GET" }),
			params: {},
		});
		expect(response.status).toBe(403);
		expect(handle).not.toHaveBeenCalled();
	});

	it("makes an instance admin key name its organization", async () => {
		resolveApiAuth.mockResolvedValue({ auth: { kind: "admin", scopes: null, organizationId: null } });
		const response = await createGeoApiHandler({ permission: "observation.read", handle: vi.fn() })({
			request: request({ method: "GET" }),
			params: {},
		});
		expect(response.status).toBe(400);
		expect((await errorOf(response)).code).toBe("VALIDATION_ERROR");
	});

	it("wraps refusals from the shared handler and domain errors in one envelope", async () => {
		const validated = createGeoApiHandler({
			permission: "sampling.run",
			body: z.object({ name: z.string() }),
			handle: async () => ({}),
		});
		const invalid = await validated({ request: request({ body: "{}" }), params: {} });
		expect(invalid.status).toBe(400);
		expect((await errorOf(invalid)).code).toBe("VALIDATION_ERROR");

		const required = createGeoApiHandler({
			permission: "sampling.run",
			handle: async () => {
				throw new GeoError("EVIDENCE_REQUIRED", "缺少证据");
			},
		});
		const missing = await required({ request: request(), params: {} });
		expect(missing.status).toBe(422);
		expect(await errorOf(missing)).toMatchObject({ code: "EVIDENCE_REQUIRED", message: "缺少证据" });

		resolveApiAuth.mockResolvedValue({
			failure: { status: 401, error: "Unauthorized", message: "Invalid API key", code: "unauthorized" },
		});
		const unauthorized = await required({ request: request(), params: {} });
		expect(unauthorized.status).toBe(401);
		expect((await errorOf(unauthorized)).code).toBe("UNAUTHORIZED");
	});

	it("does not leak an unexpected failure", async () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		const response = await createGeoApiHandler({
			permission: "sampling.run",
			handle: async () => {
				throw new Error("connection to s3.internal refused");
			},
		})({ request: request(), params: {} });
		expect(response.status).toBe(500);
		const error = await errorOf(response);
		expect(error.code).toBe("INTERNAL_ERROR");
		expect(error.message).not.toContain("s3.internal");
		expect(consoleError).toHaveBeenCalled();
	});

	it("validates the query string", async () => {
		const handler = createGeoApiHandler({
			permission: "observation.read",
			query: z.object({ status: z.enum(["VALID"]) }),
			handle: async ({ query }) => query,
		});
		const url = "http://localhost/api/v1/geo/test";
		const headers = { Authorization: "Bearer key" };
		const ok = await handler({ request: new Request(`${url}?status=VALID`, { headers }), params: {} });
		expect(await ok.json()).toEqual({ status: "VALID" });
		const bad = await handler({ request: new Request(`${url}?status=NOPE`, { headers }), params: {} });
		expect((await errorOf(bad)).code).toBe("VALIDATION_ERROR");
	});

	describe("Idempotency-Key", () => {
		function counting() {
			const handle = vi.fn(async () => ({ id: "batch-1" }));
			return {
				handle,
				handler: createGeoApiHandler({ permission: "sampling.run", idempotent: true, status: 202, handle }),
			};
		}
		const withKey = (body: string, key = "key-abc") => request({ body, headers: { "Idempotency-Key": key } });

		it("replays the first result instead of running twice", async () => {
			const { handle, handler } = counting();
			await handler({ request: withKey('{"a":1}'), params: {} });
			const replay = await handler({ request: withKey('{"a":1}'), params: {} });
			expect(handle).toHaveBeenCalledTimes(1);
			expect(replay.status).toBe(202);
			expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
			expect(await replay.json()).toEqual({ id: "batch-1" });
		});

		it("refuses one key with a different body", async () => {
			const { handle, handler } = counting();
			await handler({ request: withKey('{"a":1}'), params: {} });
			const response = await handler({ request: withKey('{"a":2}'), params: {} });
			expect(response.status).toBe(409);
			expect((await errorOf(response)).code).toBe("CONFLICT");
			expect(handle).toHaveBeenCalledTimes(1);
		});

		it("lets a failed attempt be retried under the same key", async () => {
			const handle = vi
				.fn()
				.mockRejectedValueOnce(new GeoError("TARGET_UNAVAILABLE", "暂不可用"))
				.mockResolvedValueOnce({ id: "batch-1" });
			const handler = createGeoApiHandler({ permission: "sampling.run", idempotent: true, handle });
			expect((await handler({ request: withKey("{}"), params: {} })).status).toBe(503);
			expect((await handler({ request: withKey("{}"), params: {} })).status).toBe(200);
		});

		it("runs every time without the header", async () => {
			const { handle, handler } = counting();
			await handler({ request: request({ body: "{}" }), params: {} });
			await handler({ request: request({ body: "{}" }), params: {} });
			expect(handle).toHaveBeenCalledTimes(2);
		});
	});

	it("stays visible to the route conformance checks, scope included", () => {
		const read = createGeoApiHandler({ permission: "observation.read", handle: async () => ({}) });
		const write = createGeoApiHandler({ permission: "sampling.run", handle: async () => ({}) });
		expect(apiHandlerMeta(read)).toEqual({ kind: "endpoint", scopes: ["read"], adminOnly: false });
		expect(apiHandlerMeta(write)).toEqual({ kind: "endpoint", scopes: ["write"], adminOnly: false });
	});
});

describe("withGeoMethodGuard", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("answers an unclaimed verb with 405 in the GEO envelope and keeps the stamp", async () => {
		vi.stubEnv("GEO_WORKSPACE_ENABLED", "1");
		const guarded = withGeoMethodGuard({
			GET: createGeoApiHandler({ permission: "observation.read", handle: async () => ({}) }),
		}) as unknown as Record<string, (args: { request: Request; params: Record<string, string> }) => Promise<Response>>;
		const response = await guarded.POST({ request: request(), params: {} });
		expect(response.status).toBe(405);
		expect((await errorOf(response)).code).toBe("METHOD_NOT_ALLOWED");
		expect(response.headers.get("Allow")).toBe("GET");
		expect(apiHandlerMeta(guarded.POST)?.kind).toBe("method-guard");
		expect(Object.keys(guarded).sort()).toEqual(["DELETE", "GET", "PATCH", "POST", "PUT"]);
	});
});
