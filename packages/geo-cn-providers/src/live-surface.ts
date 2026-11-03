import { type CaptureFailure, captureFailure } from "./classify";
import type { LiveSurfaceConfig } from "./config";
import { readDoubaoAppResponse } from "./doubao-app";
import { extractCitations, failedCapture, headerValue, isHttpUrl, requestJson } from "./http";
import { fillTemplate, readPath } from "./json-path";
import type { CaptureCapabilities, CaptureRequest, CaptureResult, FetchLike, GeoCaptureAdapter } from "./types";

export const LIVE_SURFACE_PROVIDER_VERSION = "live-surface-licensed-http/1";
export const DOUBAO_APP_PROVIDER_VERSION = "live-surface-doubao-app/1";

function stringAt(body: unknown, path: string | undefined): string | undefined {
	if (!path) return undefined;
	const value = readPath(body, path);
	if (typeof value === "string") return value;
	if (typeof value === "number") return String(value);
	return undefined;
}

function mappedFailure(config: LiveSurfaceConfig, status: string | undefined): CaptureFailure | "PARTIAL" | null {
	const map = config.response.statusMap;
	if (!status || !map) return null;
	const matches = (list?: string[]) => list?.some((item) => item.toLowerCase() === status.toLowerCase()) ?? false;
	if (matches(map.captcha))
		return captureFailure("CAPTCHA", "CAPTCHA_REQUIRED", "服务商报告平台要求验证码，需人工处理");
	if (matches(map.rateLimited)) return captureFailure("RATE_LIMITED", "RATE_LIMITED", "服务商报告平台限流");
	if (matches(map.needsManual)) return captureFailure("MANUAL_ONLY", "NEEDS_MANUAL", "服务商报告需要人工处理");
	if (matches(map.unavailable)) return captureFailure("UNSUPPORTED", "UNAVAILABLE", "服务商报告该平台当前不可用");
	if (matches(map.partial)) return "PARTIAL";
	return null;
}

function reportedSampledAt(json: unknown, config: LiveSurfaceConfig): string | undefined {
	const reported = stringAt(json, config.response.sampledAt);
	return reported && !Number.isNaN(Date.parse(reported)) ? new Date(reported).toISOString() : undefined;
}

function describeResponse(
	json: unknown,
	config: LiveSurfaceConfig,
	headers: Headers,
	durationMs: number,
): Partial<CaptureResult> {
	const screenshot = stringAt(json, config.response.screenshotUrl);
	return {
		raw: json,
		providerTraceId:
			stringAt(json, config.response.traceId)?.slice(0, 200) ?? headerValue(headers, ["x-request-id", "x-trace-id"]),
		modelVersion: stringAt(json, config.response.modelVersion)?.slice(0, 200),
		costEstimate: config.costPerRequest,
		responseMetadata: {
			proxyEvaluation: false,
			serviceName: config.serviceName,
			licenseNote: config.licenseNote,
			appVersion: stringAt(json, config.response.appVersion)?.slice(0, 200) ?? null,
			reportedStatus: stringAt(json, config.response.status)?.slice(0, 64) ?? null,
			screenshotUrl: isHttpUrl(screenshot) ? screenshot : null,
			durationMs,
		},
	};
}

function doubaoAppCapture(
	json: unknown,
	located: { surfaceMode: "LIVE_SURFACE"; providerVersion: string; sampledAt: string },
	shared: Partial<CaptureResult>,
): CaptureResult {
	const answer = readDoubaoAppResponse(json);
	const result = {
		...shared,
		...located,
		providerVersion: DOUBAO_APP_PROVIDER_VERSION,
		modelVersion: answer.model,
		providerTraceId: answer.responseId ?? shared.providerTraceId,
		responseMetadata: {
			...shared.responseMetadata,
			doubaoAppFeature: answer.feature ?? null,
			searchSummaries: answer.searchSummaries,
			searchQueries: answer.searchQueries,
		},
	};
	if (answer.outcome !== "complete" && answer.outcome !== "partial") {
		return failedCapture(result, answer.outcome, result);
	}
	if (!answer.text) {
		return failedCapture(result, captureFailure("EMPTY_RESPONSE", "EMPTY_RESPONSE", "服务商返回了空回答"), result);
	}
	const partial = answer.outcome === "partial";
	return {
		...result,
		status: partial ? "PARTIAL" : "VALID",
		responseText: answer.text,
		citations: answer.citations,
		errorCode: partial ? "PROVIDER_PARTIAL" : undefined,
	};
}

/**
 * A licensed third-party service that captures what a consumer AI app actually showed.
 * Endpoint, request shape and response mapping all come from configuration; nothing
 * here drives a browser or works around a platform's own access controls.
 */
export class LicensedHttpAdapter implements GeoCaptureAdapter {
	constructor(
		private readonly options: {
			config: LiveSurfaceConfig;
			credential: string | null;
			platform: string;
			fetch: FetchLike;
			timeoutMs: number;
			now?: () => Date;
		},
	) {}

	private get fetchImpl(): FetchLike {
		return this.options.fetch;
	}

	private authHeaders(): Record<string, string> | null {
		const { auth } = this.options.config;
		if (auth.type === "none") return {};
		if (!this.options.credential) return null;
		return auth.type === "bearer"
			? { Authorization: `Bearer ${this.options.credential}` }
			: { [auth.name]: this.options.credential };
	}

	async capabilities(): Promise<CaptureCapabilities> {
		const auth = this.authHeaders();
		if (!auth) return { available: false, mode: "LIVE_SURFACE", detail: "未配置凭据" };
		const { healthEndpoint, serviceName } = this.options.config;
		if (!healthEndpoint) {
			return { available: true, mode: "LIVE_SURFACE", detail: `${serviceName} 未提供健康检查端点，仅校验了配置完整性` };
		}
		const outcome = await requestJson(this.fetchImpl, healthEndpoint, {
			method: "GET",
			headers: { ...this.options.config.headers, ...auth },
			timeoutMs: Math.min(this.options.timeoutMs, 15_000),
		});
		return outcome.ok
			? { available: true, mode: "LIVE_SURFACE", detail: `${serviceName} 健康检查通过，耗时 ${outcome.durationMs} ms` }
			: { available: false, mode: "LIVE_SURFACE", detail: outcome.failure.message };
	}

	async capture(input: CaptureRequest): Promise<CaptureResult> {
		const { config } = this.options;
		const now = this.options.now ?? (() => new Date());
		const base = { surfaceMode: "LIVE_SURFACE" as const, providerVersion: LIVE_SURFACE_PROVIDER_VERSION };
		const auth = this.authHeaders();
		if (!auth) {
			return failedCapture(
				{ ...base, sampledAt: now().toISOString() },
				captureFailure("CONFIG", "CREDENTIAL_MISSING", "未配置凭据"),
			);
		}

		const outcome = await requestJson(this.fetchImpl, config.endpoint, {
			method: "POST",
			headers: { ...config.headers, ...auth, "Idempotency-Key": input.idempotencyKey },
			body: fillTemplate(config.request, {
				prompt: input.promptText,
				region: input.region,
				language: input.language,
				platform: this.options.platform,
				runId: input.runId,
				idempotencyKey: input.idempotencyKey,
			}),
			timeoutMs: this.options.timeoutMs,
		});
		if (!outcome.ok) return failedCapture({ ...base, sampledAt: now().toISOString() }, outcome.failure);

		const json = outcome.json;
		const located = { ...base, sampledAt: reportedSampledAt(json, config) ?? now().toISOString() };
		const shared = describeResponse(json, config, outcome.headers, outcome.durationMs);
		if (config.responseFormat === "doubao-app") return doubaoAppCapture(json, located, shared);
		const mapped = mappedFailure(config, stringAt(json, config.response.status));
		if (mapped && mapped !== "PARTIAL") return failedCapture(located, mapped, shared);

		const text = stringAt(json, config.response.text) ?? "";
		if (!text.trim()) {
			return failedCapture(located, captureFailure("EMPTY_RESPONSE", "EMPTY_RESPONSE", "服务商返回了空回答"), shared);
		}
		return {
			...shared,
			...located,
			status: mapped === "PARTIAL" ? "PARTIAL" : "VALID",
			responseText: text,
			citations: config.response.citations
				? extractCitations(json, config.response.citations, config.response.citationUrl, config.response.citationTitle)
				: [],
			errorCode: mapped === "PARTIAL" ? "PROVIDER_PARTIAL" : undefined,
		};
	}
}
