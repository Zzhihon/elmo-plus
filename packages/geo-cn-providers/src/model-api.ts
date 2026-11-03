import { captureFailure } from "./classify";
import type { ModelApiConfig } from "./config";
import { extractCitations, failedCapture, headerValue, requestJson, trimBaseUrl } from "./http";
import { readPath } from "./json-path";
import type { CaptureCapabilities, CaptureRequest, CaptureResult, FetchLike, GeoCaptureAdapter } from "./types";

export const MODEL_API_PROVIDER_VERSION = "model-api-openai-compatible/1";

interface ChatCompletion {
	id?: unknown;
	model?: unknown;
	choices?: { message?: { content?: unknown }; finish_reason?: unknown }[];
	usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown };
}

function tokens(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

const TRACE_HEADERS = ["x-request-id", "x-tt-logid", "x-acs-request-id", "x-ds-trace-id"];

function completionRequest(config: ModelApiConfig, promptText: string): Record<string, unknown> {
	return {
		...config.extraBody,
		model: config.model,
		messages: [{ role: "user", content: promptText }],
		stream: false,
		...(config.temperature === undefined ? {} : { temperature: config.temperature }),
		...(config.maxTokens === undefined ? {} : { max_tokens: config.maxTokens }),
	};
}

function shortString(value: unknown): string | undefined {
	return typeof value === "string" && value ? value.slice(0, 200) : undefined;
}

function readCompletion(json: unknown) {
	const body = (json ?? {}) as ChatCompletion;
	const choice = Array.isArray(body.choices) ? body.choices[0] : undefined;
	return {
		text: typeof choice?.message?.content === "string" ? choice.message.content : "",
		finishReason: typeof choice?.finish_reason === "string" ? choice.finish_reason : null,
		id: shortString(body.id),
		model: shortString(body.model),
		usage: body.usage,
	};
}

function costOf(config: ModelApiConfig, usage: ChatCompletion["usage"]): number | undefined {
	const pricing = config.pricing;
	if (!pricing) return undefined;
	const input = (tokens(usage?.prompt_tokens) / 1000) * (pricing.inputPer1k ?? 0);
	const output = (tokens(usage?.completion_tokens) / 1000) * (pricing.outputPer1k ?? 0);
	return Number((input + output + (pricing.perRequest ?? 0)).toFixed(6));
}

/**
 * Calls an OpenAI-compatible chat endpoint. What comes back is the model's answer
 * through its API, a proxy for the product: every result says so in its metadata,
 * and nothing here pretends to be the consumer app's own answer.
 */
export class ModelApiAdapter implements GeoCaptureAdapter {
	constructor(
		private readonly options: {
			config: ModelApiConfig;
			credential: string | null;
			fetch: FetchLike;
			timeoutMs: number;
			now?: () => Date;
		},
	) {}

	private get fetchImpl(): FetchLike {
		return this.options.fetch;
	}

	private authHeaders(): Record<string, string> {
		return this.options.credential ? { Authorization: `Bearer ${this.options.credential}` } : {};
	}

	async capabilities(): Promise<CaptureCapabilities> {
		if (!this.options.credential) return { available: false, mode: "MODEL_API", detail: "未配置凭据" };
		const outcome = await requestJson(this.fetchImpl, `${trimBaseUrl(this.options.config.baseUrl)}/models`, {
			method: "GET",
			headers: this.authHeaders(),
			timeoutMs: Math.min(this.options.timeoutMs, 15_000),
		});
		if (!outcome.ok) {
			// Some compatible endpoints have no model list; a 404 there still proves the key and host work.
			if (outcome.failure.code === "UNSUPPORTED") {
				return { available: true, mode: "MODEL_API", detail: "端点可达，但未提供模型列表，无法确认模型 ID" };
			}
			return { available: false, mode: "MODEL_API", detail: outcome.failure.message };
		}
		const ids = readPath(outcome.json, "data");
		const listed = Array.isArray(ids) && ids.some((item) => readPath(item, "id") === this.options.config.model);
		return {
			available: true,
			mode: "MODEL_API",
			detail: listed
				? `端点可达，模型 ${this.options.config.model} 在模型列表中，耗时 ${outcome.durationMs} ms`
				: `端点可达，但模型列表中未找到 ${this.options.config.model}，请核对模型 ID`,
		};
	}

	async capture(input: CaptureRequest): Promise<CaptureResult> {
		const { config } = this.options;
		const now = this.options.now ?? (() => new Date());
		const base = { surfaceMode: "MODEL_API" as const, providerVersion: MODEL_API_PROVIDER_VERSION };
		if (!this.options.credential) {
			return failedCapture(
				{ ...base, sampledAt: now().toISOString() },
				captureFailure("CONFIG", "CREDENTIAL_MISSING", "未配置凭据"),
			);
		}

		const outcome = await requestJson(this.fetchImpl, `${trimBaseUrl(config.baseUrl)}/chat/completions`, {
			method: "POST",
			headers: this.authHeaders(),
			timeoutMs: this.options.timeoutMs,
			body: completionRequest(config, input.promptText),
		});
		const sampledAt = now().toISOString();
		if (!outcome.ok) return failedCapture({ ...base, sampledAt }, outcome.failure);

		const completion = readCompletion(outcome.json);
		const shared: Partial<CaptureResult> = {
			providerTraceId: headerValue(outcome.headers, TRACE_HEADERS) ?? completion.id,
			modelVersion: completion.model,
			costEstimate: costOf(config, completion.usage),
			raw: outcome.json,
			responseMetadata: {
				proxyEvaluation: true,
				endpointHost: new URL(config.baseUrl).host,
				requestedModel: config.model,
				finishReason: completion.finishReason,
				usage: {
					promptTokens: tokens(completion.usage?.prompt_tokens),
					completionTokens: tokens(completion.usage?.completion_tokens),
				},
				durationMs: outcome.durationMs,
			},
		};

		if (!completion.text.trim()) {
			// Reasoning models spend max_tokens on hidden reasoning first, so a low limit
			// ends the reply before any answer text is written.
			const failure =
				completion.finishReason === "content_filter"
					? captureFailure("REFUSED", "CONTENT_REFUSED", "平台以内容安全为由未返回回答")
					: completion.finishReason === "length"
						? captureFailure(
								"EMPTY_RESPONSE",
								"TOKEN_LIMIT_BEFORE_ANSWER",
								"输出上限在回答开始前已用尽，请调高 maxTokens",
							)
						: captureFailure("EMPTY_RESPONSE", "EMPTY_RESPONSE", "平台返回了空回答");
			return failedCapture({ ...base, sampledAt }, failure, shared);
		}

		const truncated = completion.finishReason === "length" || completion.finishReason === "content_filter";
		return {
			...shared,
			...base,
			sampledAt,
			status: truncated ? "PARTIAL" : "VALID",
			responseText: completion.text,
			citations: extractCitations(
				outcome.json,
				config.citationsPath ?? "citations",
				config.citationUrlField,
				config.citationTitleField,
			),
			errorCode: truncated ? `FINISH_${completion.finishReason?.toUpperCase()}` : undefined,
		};
	}
}
