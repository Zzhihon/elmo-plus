import { type CaptureFailure, captureFailure, classifyHttpFailure, classifyThrown } from "./classify";
import { readPath } from "./json-path";
import type { CaptureCitation, CaptureResult, FetchLike, SurfaceMode } from "./types";

const MAX_BODY_BYTES = 5 * 1024 * 1024;

export type HttpOutcome =
	| { ok: true; status: number; headers: Headers; json: unknown; durationMs: number }
	| { ok: false; failure: CaptureFailure; durationMs: number };

export async function requestJson(
	fetchImpl: FetchLike,
	url: string,
	init: { method: "GET" | "POST"; headers: Record<string, string>; body?: unknown; timeoutMs: number },
): Promise<HttpOutcome> {
	const started = Date.now();
	const elapsed = () => Date.now() - started;
	let response: Response;
	let text: string;
	try {
		response = await fetchImpl(url, {
			method: init.method,
			headers: {
				Accept: "application/json",
				...init.headers,
				...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
			},
			body: init.body === undefined ? undefined : JSON.stringify(init.body),
			signal: AbortSignal.timeout(init.timeoutMs),
			redirect: "error",
		});
		const declared = Number(response.headers.get("content-length") ?? "0");
		if (declared > MAX_BODY_BYTES) {
			return {
				ok: false,
				failure: captureFailure("INVALID_RESPONSE", "RESPONSE_TOO_LARGE", "平台响应过大"),
				durationMs: elapsed(),
			};
		}
		text = await response.text();
	} catch (error) {
		return { ok: false, failure: classifyThrown(error), durationMs: elapsed() };
	}
	if (text.length > MAX_BODY_BYTES) {
		return {
			ok: false,
			failure: captureFailure("INVALID_RESPONSE", "RESPONSE_TOO_LARGE", "平台响应过大"),
			durationMs: elapsed(),
		};
	}
	if (!response.ok) {
		return { ok: false, failure: classifyHttpFailure(response.status, response.headers, text), durationMs: elapsed() };
	}
	try {
		return {
			ok: true,
			status: response.status,
			headers: response.headers,
			json: JSON.parse(text),
			durationMs: elapsed(),
		};
	} catch {
		const failure = classifyHttpFailure(response.status, response.headers, text);
		return {
			ok: false,
			failure:
				failure.kind === "CAPTCHA"
					? failure
					: captureFailure("INVALID_RESPONSE", "INVALID_JSON", "平台返回的不是 JSON"),
			durationMs: elapsed(),
		};
	}
}

export function isHttpUrl(value: unknown): value is string {
	if (typeof value !== "string") return false;
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
}

const MAX_CITATIONS = 100;

/** Accepts an array of URL strings or of objects; drops anything that is not an http(s) URL, and duplicates. */
export function extractCitations(
	body: unknown,
	path: string,
	urlField = "url",
	titleField = "title",
): CaptureCitation[] {
	const list = readPath(body, path);
	if (!Array.isArray(list)) return [];
	const seen = new Set<string>();
	const citations: CaptureCitation[] = [];
	for (const item of list) {
		const url = typeof item === "string" ? item : readPath(item, urlField);
		if (!isHttpUrl(url) || seen.has(url)) continue;
		seen.add(url);
		const title = typeof item === "object" && item ? readPath(item, titleField) : undefined;
		citations.push(typeof title === "string" && title.trim() ? { url, title: title.trim().slice(0, 500) } : { url });
		if (citations.length >= MAX_CITATIONS) break;
	}
	return citations;
}

export function trimBaseUrl(baseUrl: string): string {
	return baseUrl.replace(/\/+$/, "");
}

export function headerValue(headers: Headers, names: readonly string[]): string | undefined {
	for (const name of names) {
		const value = headers.get(name);
		if (value && /^[\x21-\x7e]{1,200}$/.test(value)) return value;
	}
	return undefined;
}

/** A capture with no usable answer; blocked or unsupported reads as unavailable, everything else as failed. */
export function failedCapture(
	base: { surfaceMode: SurfaceMode; providerVersion: string; sampledAt: string },
	failure: CaptureFailure,
	extra: Partial<CaptureResult> = {},
): CaptureResult {
	const unavailable = ["FORBIDDEN", "UNSUPPORTED", "REFUSED", "CONFIG", "CAPTCHA", "MANUAL_ONLY"].includes(
		failure.kind,
	);
	return { ...extra, ...base, status: unavailable ? "UNAVAILABLE" : "FAILED", failure, errorCode: failure.code };
}
