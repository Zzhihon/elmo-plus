import type { GeoRunStatus } from "@workspace/geo-domain";

export const CAPTURE_FAILURE_KINDS = [
	"TIMEOUT",
	"CAPTCHA",
	"RATE_LIMITED",
	"NETWORK",
	"FORBIDDEN",
	"UNSUPPORTED",
	"REFUSED",
	"UPSTREAM",
	"INVALID_RESPONSE",
	"EMPTY_RESPONSE",
	"CONFIG",
	"MANUAL_ONLY",
] as const;
export type CaptureFailureKind = (typeof CAPTURE_FAILURE_KINDS)[number];

export interface CaptureFailure {
	kind: CaptureFailureKind;
	/** A short machine code stored as the run's `error_code`. */
	code: string;
	retryable: boolean;
	retryAfterMs?: number;
	httpStatus?: number;
	/** Built from codes and statuses only, never from response or prompt text. */
	message: string;
}

const RUN_STATUS_BY_KIND: Record<CaptureFailureKind, GeoRunStatus> = {
	TIMEOUT: "TIMEOUT",
	CAPTCHA: "CAPTCHA",
	RATE_LIMITED: "RATE_LIMITED",
	NETWORK: "NETWORK_ERROR",
	FORBIDDEN: "UNAVAILABLE",
	UNSUPPORTED: "UNAVAILABLE",
	REFUSED: "UNAVAILABLE",
	UPSTREAM: "FAILED",
	INVALID_RESPONSE: "FAILED",
	EMPTY_RESPONSE: "FAILED",
	CONFIG: "UNAVAILABLE",
	MANUAL_ONLY: "NEEDS_MANUAL",
};

export function failureRunStatus(failure: Pick<CaptureFailure, "kind">): GeoRunStatus {
	return RUN_STATUS_BY_KIND[failure.kind];
}

/** Failures that say the platform is unhealthy, as opposed to this one question being refused. */
export function failureTripsBreaker(failure: Pick<CaptureFailure, "kind">): boolean {
	return (
		failure.kind === "TIMEOUT" ||
		failure.kind === "NETWORK" ||
		failure.kind === "UPSTREAM" ||
		failure.kind === "RATE_LIMITED"
	);
}

export function captureFailure(
	kind: CaptureFailureKind,
	code: string,
	message: string,
	extra: Partial<Pick<CaptureFailure, "retryAfterMs" | "httpStatus">> = {},
): CaptureFailure {
	const retryable = kind === "TIMEOUT" || kind === "NETWORK" || kind === "RATE_LIMITED" || kind === "UPSTREAM";
	return { kind, code, retryable, message, ...extra };
}

const CAPTCHA_MARKERS = [
	/captcha/i,
	/验证码/,
	/人机验证/,
	/安全验证/,
	/verify you are (a )?human/i,
	/challenge-platform/i,
];
const REFUSAL_MARKERS = [
	/data_inspection_failed/i,
	/sensitive[_ ]?content/i,
	/content[_ ]?filter/i,
	/content[_ ]?policy/i,
	/内容安全/,
	/敏感/,
];
const CODE_SHAPE = /^[A-Za-z0-9_.-]{1,64}$/;

function providerErrorCode(body: string): string | null {
	try {
		const parsed = JSON.parse(body) as { error?: { code?: unknown; type?: unknown } | string; code?: unknown };
		const candidates = [
			typeof parsed.error === "object" && parsed.error ? parsed.error.code : undefined,
			typeof parsed.error === "object" && parsed.error ? parsed.error.type : undefined,
			parsed.code,
		];
		for (const candidate of candidates) {
			const value = typeof candidate === "number" ? String(candidate) : candidate;
			if (typeof value === "string" && CODE_SHAPE.test(value)) return value;
		}
	} catch {
		return null;
	}
	return null;
}

export function parseRetryAfter(value: string | null, now: number = Date.now()): number | undefined {
	if (!value) return undefined;
	const seconds = Number(value);
	if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
	const date = Date.parse(value);
	return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/**
 * Sorts an HTTP refusal into a failure kind. The body is only matched against markers
 * and mined for a short error code; none of its text reaches the failure message.
 */
export function classifyHttpFailure(status: number, headers: Headers, body: string): CaptureFailure {
	const code = providerErrorCode(body);
	const suffix = code ? ` (${code})` : "";
	const http = { httpStatus: status };

	if (CAPTCHA_MARKERS.some((marker) => marker.test(body))) {
		return captureFailure("CAPTCHA", "CAPTCHA_REQUIRED", `平台要求验证码或人机验证，HTTP ${status}`, http);
	}
	if (status === 429) {
		return captureFailure("RATE_LIMITED", "RATE_LIMITED", `平台限流，HTTP 429${suffix}`, {
			...http,
			retryAfterMs: parseRetryAfter(headers.get("retry-after")),
		});
	}
	if (status === 408 || status === 504) {
		return captureFailure("TIMEOUT", "UPSTREAM_TIMEOUT", `平台超时，HTTP ${status}${suffix}`, http);
	}
	if (status === 401 || status === 403) {
		return captureFailure(
			"FORBIDDEN",
			status === 401 ? "UNAUTHORIZED" : "FORBIDDEN",
			`平台拒绝访问，HTTP ${status}${suffix}`,
			http,
		);
	}
	if (status === 402) {
		return captureFailure("FORBIDDEN", "PAYMENT_REQUIRED", `平台账户余额或额度不足，HTTP 402${suffix}`, http);
	}
	if (status === 404 || status === 405 || status === 501) {
		return captureFailure("UNSUPPORTED", "UNSUPPORTED", `平台不支持该请求，HTTP ${status}${suffix}`, http);
	}
	if (status >= 400 && status < 500 && REFUSAL_MARKERS.some((marker) => marker.test(body))) {
		return captureFailure("REFUSED", "CONTENT_REFUSED", `平台以内容安全为由拒绝回答，HTTP ${status}${suffix}`, http);
	}
	if (status >= 500) {
		return captureFailure("UPSTREAM", `HTTP_${status}`, `平台服务异常，HTTP ${status}${suffix}`, http);
	}
	return captureFailure("UPSTREAM", `HTTP_${status}`, `平台返回错误，HTTP ${status}${suffix}`, {
		...http,
	});
}

const NETWORK_CODES = new Set([
	"ECONNRESET",
	"ECONNREFUSED",
	"ENOTFOUND",
	"EAI_AGAIN",
	"EHOSTUNREACH",
	"ENETUNREACH",
	"EPIPE",
	"UND_ERR_SOCKET",
	"UND_ERR_CONNECT_TIMEOUT",
	"CERT_HAS_EXPIRED",
	"UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

function errorCodeOf(error: unknown): string | undefined {
	if (!error || typeof error !== "object") return undefined;
	const own = (error as { code?: unknown }).code;
	if (typeof own === "string") return own;
	return errorCodeOf((error as { cause?: unknown }).cause);
}

/** For a thrown fetch error; the error's own message is never kept, it can carry URLs with query secrets. */
export function classifyThrown(error: unknown): CaptureFailure {
	const name = error instanceof Error ? error.name : "";
	const code = errorCodeOf(error);
	if (name === "TimeoutError" || name === "AbortError" || code === "UND_ERR_HEADERS_TIMEOUT" || code === "ETIMEDOUT") {
		return captureFailure("TIMEOUT", "TIMEOUT", "请求超时");
	}
	if (
		(code && NETWORK_CODES.has(code)) ||
		(error instanceof TypeError && /fetch failed|network/i.test(error.message))
	) {
		return captureFailure("NETWORK", code && CODE_SHAPE.test(code) ? code : "NETWORK", "网络错误，无法连接平台");
	}
	return captureFailure("UPSTREAM", "UNEXPECTED", "采样时发生未预期的错误");
}
