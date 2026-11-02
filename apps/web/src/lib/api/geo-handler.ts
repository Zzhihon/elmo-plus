/**
 * Every `/api/v1/geo` endpoint goes through here. It wraps `createApiHandler`, so
 * key verification, rate limits and the conformance stamp stay in one place, and adds
 * the feature switch, the GEO permission check, a request id, `Idempotency-Key` replay
 * and the `{ error: { code, message, request_id } }` envelope.
 */

import { createHash } from "node:crypto";
import { isGeoWorkspaceEnabled } from "@workspace/config/geo";
import {
	assertGeoPermission,
	GeoError,
	type GeoErrorCode,
	type GeoPermission,
	type GeoPrincipal,
	permissionAccess,
} from "@workspace/geo-domain";
import { db } from "@workspace/lib/db/db";
import {
	claimGeoIdempotencyKey,
	completeGeoIdempotencyKey,
	releaseGeoIdempotencyKey,
} from "@workspace/lib/geo/idempotency";
import type { z } from "zod";
import { geoRequestId, resolveGeoApiPrincipal } from "@/server/geo/context";
import { clampedPaging, pagination } from "./analytics-range";
import { type ApiHandlerMeta, apiHandlerMeta, createApiHandler, stampApiHandler, withMethodGuard } from "./handler";
import { geoApiScope } from "./scopes";

export function geoErrorResponse(code: GeoErrorCode, message: string, status: number, requestId: string): Response {
	return Response.json({ error: { code, message, request_id: requestId } }, { status });
}

const INNER_CODE_TO_GEO: Record<string, GeoErrorCode> = {
	unauthorized: "UNAUTHORIZED",
	insufficient_scope: "FORBIDDEN",
	forbidden: "FORBIDDEN",
	read_only: "FORBIDDEN",
	not_found: "NOT_FOUND",
	validation_error: "VALIDATION_ERROR",
	conflict: "CONFLICT",
	rate_limited: "RATE_LIMITED",
	method_not_allowed: "METHOD_NOT_ALLOWED",
};

/** What `createApiHandler` refuses arrives as `{ error: "text", message, code }`; a GEO error's `error` is already an object. */
async function withGeoEnvelope(response: Response, requestId: string): Promise<Response> {
	let result = response;
	if (response.status >= 400) {
		const body = (await response
			.clone()
			.json()
			.catch(() => null)) as { error?: unknown; message?: unknown; code?: unknown } | null;
		if (body && typeof body.error === "string") {
			const code = INNER_CODE_TO_GEO[String(body.code)] ?? "INTERNAL_ERROR";
			result = new Response(
				JSON.stringify({ error: { code, message: String(body.message ?? body.error), request_id: requestId } }),
				{ status: response.status, headers: response.headers },
			);
		}
	}
	const stamped = new Response(result.body, { status: result.status, headers: result.headers });
	stamped.headers.set("X-Request-Id", requestId);
	return stamped;
}

type RouteArgs = { request: Request; params: Record<string, string> };

/** Reads like any other unknown path, so a disabled workspace is not discoverable. */
function disabledResponse(requestId: string): Promise<Response> {
	return withGeoEnvelope(geoErrorResponse("NOT_FOUND", "Not Found", 404, requestId), requestId);
}

function validationMessage(error: z.ZodError): string {
	return error.issues
		.map((issue) => (issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message))
		.join("; ");
}

const IDEMPOTENCY_KEY_SHAPE = /^[\x21-\x7e]{1,255}$/;

async function runIdempotent(
	request: Request,
	principal: GeoPrincipal,
	requestHash: string,
	run: () => Promise<Response>,
): Promise<Response> {
	const key = request.headers.get("Idempotency-Key");
	if (key === null) return run();
	if (!IDEMPOTENCY_KEY_SHAPE.test(key)) {
		throw new GeoError("VALIDATION_ERROR", "Idempotency-Key 格式无效");
	}

	const scope = {
		organizationId: principal.organizationId,
		key,
		route: `${request.method} ${new URL(request.url).pathname}`,
	};
	const claim = await claimGeoIdempotencyKey(db, { ...scope, requestHash });
	if (claim.kind === "mismatch") throw new GeoError("CONFLICT", "同一 Idempotency-Key 已用于不同的请求内容");
	if (claim.kind === "in_flight") throw new GeoError("CONFLICT", "使用此 Idempotency-Key 的请求仍在处理中");
	if (claim.kind === "replay") {
		return Response.json(claim.body, { status: claim.status, headers: { "Idempotency-Replayed": "true" } });
	}

	try {
		const response = await run();
		if (!response.ok) {
			await releaseGeoIdempotencyKey(db, scope);
			return response;
		}
		const body = await response
			.clone()
			.json()
			.catch(() => null);
		await completeGeoIdempotencyKey(db, { ...scope, status: response.status, body });
		return response;
	} catch (error) {
		// A domain refusal rolled its transaction back, so a retry is safe. Anything else may
		// have failed after a commit, so the key stays claimed until it expires as in flight.
		if (error instanceof GeoError) await releaseGeoIdempotencyKey(db, scope);
		throw error;
	}
}

export interface GeoApiContext<P, B, Q> {
	params: P;
	body: B;
	query: Q;
	request: Request;
	principal: GeoPrincipal;
	requestId: string;
}

export interface GeoApiHandlerOptions<P, B, Q> {
	permission: GeoPermission;
	params?: z.ZodType<P>;
	body?: z.ZodType<B>;
	query?: z.ZodType<Q>;
	status?: number;
	/** Replays a stored 2xx for a repeated `Idempotency-Key`. The header stays optional for the caller. */
	idempotent?: boolean;
	handle: (ctx: GeoApiContext<P, B, Q>) => Promise<Response | object>;
}

function parseQuery<Q>(schema: z.ZodType<Q> | undefined, request: Request): Q {
	if (!schema) return undefined as Q;
	const parsed = schema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
	if (!parsed.success) throw new GeoError("VALIDATION_ERROR", validationMessage(parsed.error));
	return parsed.data;
}

export function createGeoApiHandler<P = Record<string, string>, B = undefined, Q = undefined>(
	opts: GeoApiHandlerOptions<P, B, Q>,
) {
	const scopes = [geoApiScope(permissionAccess(opts.permission))];

	const handler = async (args: RouteArgs): Promise<Response> => {
		const requestId = geoRequestId(args.request);
		if (!isGeoWorkspaceEnabled()) return disabledResponse(requestId);

		// Read here because the body is consumed once `createApiHandler` validates it.
		const requestHash = opts.idempotent
			? createHash("sha256")
					.update(await args.request.clone().text())
					.digest("hex")
			: null;

		const inner = createApiHandler<P, B>({
			params: opts.params,
			body: opts.body,
			scopes,
			handle: async ({ params, body, request, auth }) => {
				try {
					const principal = await resolveGeoApiPrincipal(auth, request, requestId);
					assertGeoPermission(principal, opts.permission);
					const query = parseQuery(opts.query, request);
					const run = async (): Promise<Response> => {
						const result = await opts.handle({ params, body, query, request, principal, requestId });
						return result instanceof Response ? result : Response.json(result, { status: opts.status ?? 200 });
					};
					return requestHash === null ? await run() : await runIdempotent(request, principal, requestHash, run);
				} catch (error) {
					if (error instanceof GeoError) return geoErrorResponse(error.code, error.message, error.status, requestId);
					throw error;
				}
			},
		});
		return withGeoEnvelope(await inner(args), requestId);
	};

	return stampApiHandler(handler, { kind: "endpoint", scopes, adminOnly: false });
}

/** The GEO counterpart of `withMethodGuard`: an unclaimed verb answers 405 in the GEO envelope. */
export function withGeoMethodGuard<T extends Record<string, unknown>>(handlers: T): T {
	const guarded = withMethodGuard(handlers) as Record<string, unknown>;
	for (const [method, guard] of Object.entries(guarded)) {
		if (method in handlers) continue;
		const respond = guard as (args: RouteArgs) => Promise<Response>;
		guarded[method] = stampApiHandler(async (args: RouteArgs) => {
			const requestId = geoRequestId(args.request);
			if (!isGeoWorkspaceEnabled()) return disabledResponse(requestId);
			return withGeoEnvelope(await respond(args), requestId);
		}, apiHandlerMeta(guard) as ApiHandlerMeta);
	}
	return guarded as T;
}

export interface GeoPage<T> {
	data: T[];
	pagination: { page: number; limit: number; total: number; totalPages: number };
}

export function geoPaging(request: Request): { page: number; limit: number; offset: number } {
	return clampedPaging(new URL(request.url).searchParams);
}

export function geoPage<T>(data: T[], total: number, paging: { page: number; limit: number }): GeoPage<T> {
	return { data, pagination: pagination(paging.page, paging.limit, total) };
}
