import type { GeoSurfaceMode } from "@workspace/geo-domain";
import { isValidPath } from "./json-path";

export type ConfigResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

export interface ModelApiPricing {
	/** Estimated cost per 1,000 input tokens, in the organization's budget unit. */
	inputPer1k?: number;
	outputPer1k?: number;
	perRequest?: number;
}

export interface ModelApiConfig {
	baseUrl: string;
	model: string;
	temperature?: number;
	maxTokens?: number;
	/** Provider switches such as turning on web search; may not override the model or the messages. */
	extraBody?: Record<string, unknown>;
	citationsPath?: string;
	citationUrlField?: string;
	citationTitleField?: string;
	pricing?: ModelApiPricing;
}

export interface LiveSurfaceStatusMap {
	captcha?: string[];
	rateLimited?: string[];
	unavailable?: string[];
	needsManual?: string[];
	partial?: string[];
}

/**
 * `mapped` reads the answer through the configured field paths. `doubao-app` reads the
 * Volcengine Ark Responses API with the `doubao_app` tool, whose answer and search results
 * arrive as typed blocks in no fixed order, so field paths cannot address them.
 */
export const LIVE_SURFACE_RESPONSE_FORMATS = ["mapped", "doubao-app"] as const;
export type LiveSurfaceResponseFormat = (typeof LIVE_SURFACE_RESPONSE_FORMATS)[number];

export interface LiveSurfaceConfig {
	/** Name of the licensed service and where its licence is recorded; shown beside every result. */
	serviceName: string;
	licenseNote: string;
	endpoint: string;
	healthEndpoint?: string;
	auth: { type: "bearer" } | { type: "header"; name: string } | { type: "none" };
	headers?: Record<string, string>;
	request: unknown;
	responseFormat: LiveSurfaceResponseFormat;
	response: {
		text: string;
		citations?: string;
		citationUrl?: string;
		citationTitle?: string;
		modelVersion?: string;
		appVersion?: string;
		traceId?: string;
		sampledAt?: string;
		status?: string;
		statusMap?: LiveSurfaceStatusMap;
		screenshotUrl?: string;
	};
	costPerRequest?: number;
}

const SECRETISH_KEY =
	/secret|password|passwd|credential|api[-_]?key|authorization|cookie|bearer|access[-_]?token|auth[-_]?token|^token$/i;
/** Configured headers are readable by everyone who can see a target, so only known-harmless ones may be stored. */
const ALLOWED_HEADERS = new Set([
	"accept",
	"accept-language",
	"user-agent",
	"api-version",
	"x-api-version",
	"x-client-name",
	"x-client-version",
	"x-request-source",
	"ark-beta-doubao-app",
]);

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Credentials only ever live in the encrypted store; a config that carries one is refused rather than stored. */
export function findSecretKeys(value: unknown, path = "config"): string[] {
	if (Array.isArray(value)) return value.flatMap((item, index) => findSecretKeys(item, `${path}[${index}]`));
	const record = asRecord(value);
	if (!record) return [];
	return Object.entries(record).flatMap(([key, item]) => [
		...(SECRETISH_KEY.test(key) ? [`${path}.${key}`] : []),
		...findSecretKeys(item, `${path}.${key}`),
	]);
}

function httpsUrl(value: unknown, field: string, errors: string[]): string | undefined {
	if (typeof value !== "string" || !value) {
		errors.push(`${field} 必填`);
		return undefined;
	}
	try {
		const url = new URL(value);
		if (url.protocol !== "https:") errors.push(`${field} 必须使用 https`);
		if (url.username || url.password) errors.push(`${field} 不得包含账号密码`);
		if (url.search) errors.push(`${field} 不得包含查询参数，凭据请通过凭据引用配置`);
		return value;
	} catch {
		errors.push(`${field} 不是有效的 URL`);
		return undefined;
	}
}

function optionalNumber(value: unknown, field: string, min: number, max: number, errors: string[]): number | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
		errors.push(`${field} 必须是 ${min}–${max} 之间的数字`);
		return undefined;
	}
	return value;
}

function optionalPath(value: unknown, field: string, errors: string[]): string | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	if (!isValidPath(value)) {
		errors.push(`${field} 不是有效的字段路径`);
		return undefined;
	}
	return value;
}

function plainHeaders(value: unknown, errors: string[]): Record<string, string> | undefined {
	if (value === undefined || value === null) return undefined;
	const record = asRecord(value);
	if (!record) {
		errors.push("headers 必须是对象");
		return undefined;
	}
	const headers: Record<string, string> = {};
	for (const [name, item] of Object.entries(record)) {
		if (!ALLOWED_HEADERS.has(name.toLowerCase())) {
			errors.push(`headers.${name} 不允许在配置中设置；密钥类请求头请用 auth 配置并通过“设置凭据”保存`);
		} else if (typeof item !== "string" || !/^[\x20-\x7e]{0,500}$/.test(item)) {
			errors.push(`headers.${name} 必须是 ASCII 字符串`);
		} else {
			headers[name] = item;
		}
	}
	return headers;
}

function optionalRecord(value: unknown, field: string, errors: string[]): Record<string, unknown> | undefined {
	if (value === undefined || value === null) return undefined;
	const record = asRecord(value);
	if (!record) errors.push(`${field} 必须是对象`);
	return record ?? undefined;
}

function requiredText(value: unknown, message: string, errors: string[]): string {
	const text = typeof value === "string" ? value.trim() : "";
	if (!text) errors.push(message);
	return text;
}

function secretKeyErrors(record: Record<string, unknown>): string[] {
	return findSecretKeys(record).map((path) => `${path} 看起来是凭据，请改用凭据引用`);
}

function parsePricing(value: unknown, errors: string[]): ModelApiPricing | undefined {
	const record = optionalRecord(value, "pricing", errors);
	if (!record) return undefined;
	return {
		inputPer1k: optionalNumber(record.inputPer1k, "pricing.inputPer1k", 0, 1000, errors),
		outputPer1k: optionalNumber(record.outputPer1k, "pricing.outputPer1k", 0, 1000, errors),
		perRequest: optionalNumber(record.perRequest, "pricing.perRequest", 0, 1000, errors),
	};
}

function parseExtraBody(value: unknown, errors: string[]): Record<string, unknown> | undefined {
	const record = optionalRecord(value, "extraBody", errors);
	if (record && ("model" in record || "messages" in record)) errors.push("extraBody 不能覆盖 model 或 messages");
	return record;
}

export function parseModelApiConfig(config: unknown, modelId: string | null): ConfigResult<ModelApiConfig> {
	const record = asRecord(config) ?? {};
	const errors = secretKeyErrors(record);
	const model = typeof record.model === "string" && record.model ? record.model : modelId;
	if (!model) errors.push("模型 ID 必填");
	const value: ModelApiConfig = {
		baseUrl: httpsUrl(record.baseUrl, "baseUrl", errors) ?? "",
		model: model ?? "",
		temperature: optionalNumber(record.temperature, "temperature", 0, 2, errors),
		maxTokens: optionalNumber(record.maxTokens, "maxTokens", 1, 32_000, errors),
		extraBody: parseExtraBody(record.extraBody, errors),
		citationsPath: optionalPath(record.citationsPath, "citationsPath", errors),
		citationUrlField: optionalPath(record.citationUrlField, "citationUrlField", errors),
		citationTitleField: optionalPath(record.citationTitleField, "citationTitleField", errors),
		pricing: parsePricing(record.pricing, errors),
	};
	return errors.length ? { ok: false, errors } : { ok: true, value };
}

function stringList(value: unknown, field: string, errors: string[]): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
		errors.push(`${field} 必须是字符串数组`);
		return undefined;
	}
	return value as string[];
}

const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;

function parseAuth(value: unknown, errors: string[]): LiveSurfaceConfig["auth"] {
	const record = asRecord(value);
	if (!record || record.type === "none") return { type: "none" };
	if (record.type === "bearer") return { type: "bearer" };
	if (record.type === "header" && typeof record.name === "string" && HEADER_NAME.test(record.name)) {
		return { type: "header", name: record.name };
	}
	errors.push("auth.type 必须是 bearer、header（带 name）或 none");
	return { type: "none" };
}

function parseStatusMap(value: unknown, errors: string[]): LiveSurfaceStatusMap | undefined {
	const record = optionalRecord(value, "response.statusMap", errors);
	if (!record) return undefined;
	return {
		captcha: stringList(record.captcha, "statusMap.captcha", errors),
		rateLimited: stringList(record.rateLimited, "statusMap.rateLimited", errors),
		unavailable: stringList(record.unavailable, "statusMap.unavailable", errors),
		needsManual: stringList(record.needsManual, "statusMap.needsManual", errors),
		partial: stringList(record.partial, "statusMap.partial", errors),
	};
}

const OPTIONAL_RESPONSE_PATHS = [
	"citations",
	"citationUrl",
	"citationTitle",
	"modelVersion",
	"appVersion",
	"traceId",
	"sampledAt",
	"status",
	"screenshotUrl",
] as const;

function parseResponseFormat(value: unknown, errors: string[]): LiveSurfaceResponseFormat {
	if (value === undefined || value === null) return "mapped";
	if (LIVE_SURFACE_RESPONSE_FORMATS.includes(value as LiveSurfaceResponseFormat)) {
		return value as LiveSurfaceResponseFormat;
	}
	errors.push(`responseFormat 必须是 ${LIVE_SURFACE_RESPONSE_FORMATS.join("、")} 之一`);
	return "mapped";
}

function parseResponseMapping(
	value: unknown,
	format: LiveSurfaceResponseFormat,
	errors: string[],
): LiveSurfaceConfig["response"] {
	const record = asRecord(value);
	if (!record) {
		if (format === "mapped") errors.push("response 映射必填");
		return { text: "" };
	}
	const text = optionalPath(record.text, "response.text", errors);
	if (!text && format === "mapped") errors.push("response.text 必填");
	const mapping: LiveSurfaceConfig["response"] = {
		text: text ?? "",
		statusMap: parseStatusMap(record.statusMap, errors),
	};
	for (const field of OPTIONAL_RESPONSE_PATHS) {
		mapping[field] = optionalPath(record[field], `response.${field}`, errors);
	}
	return mapping;
}

export function parseLiveSurfaceConfig(config: unknown): ConfigResult<LiveSurfaceConfig> {
	const record = asRecord(config) ?? {};
	const errors = secretKeyErrors(record);
	if (record.request === undefined) errors.push("request 模板必填");
	const responseFormat = parseResponseFormat(record.responseFormat, errors);
	const value: LiveSurfaceConfig = {
		serviceName: requiredText(record.serviceName, "serviceName（已获许可的第三方服务名称）必填", errors),
		licenseNote: requiredText(record.licenseNote, "licenseNote（许可依据）必填", errors),
		endpoint: httpsUrl(record.endpoint, "endpoint", errors) ?? "",
		healthEndpoint:
			record.healthEndpoint === undefined ? undefined : httpsUrl(record.healthEndpoint, "healthEndpoint", errors),
		auth: parseAuth(record.auth, errors),
		headers: plainHeaders(record.headers, errors),
		request: record.request,
		responseFormat,
		response: parseResponseMapping(record.response, responseFormat, errors),
		costPerRequest: optionalNumber(record.costPerRequest, "costPerRequest", 0, 1000, errors),
	};
	return errors.length ? { ok: false, errors } : { ok: true, value };
}

/** Whether a target's configuration is complete enough to run; the manual mode needs none. */
export function validateTargetConfig(
	mode: GeoSurfaceMode,
	config: unknown,
	modelId: string | null,
): { ok: true } | { ok: false; errors: string[] } {
	if (mode === "MANUAL_EVIDENCE") {
		const secretKeys = findSecretKeys(config);
		return secretKeys.length ? { ok: false, errors: secretKeys.map((path) => `${path} 看起来是凭据`) } : { ok: true };
	}
	const result = mode === "MODEL_API" ? parseModelApiConfig(config, modelId) : parseLiveSurfaceConfig(config);
	return result.ok ? { ok: true } : { ok: false, errors: result.errors };
}

/** Every URL a target's configuration would send requests to, valid or not. */
export function targetEndpointUrls(mode: GeoSurfaceMode, config: unknown): string[] {
	const record = asRecord(config) ?? {};
	const candidates =
		mode === "MODEL_API" ? [record.baseUrl] : mode === "LIVE_SURFACE" ? [record.endpoint, record.healthEndpoint] : [];
	return candidates.filter((value): value is string => typeof value === "string" && value.length > 0);
}

/** The hosts a target's credential would be sent to. */
export function targetEndpointHosts(mode: GeoSurfaceMode, config: unknown): Set<string> {
	const hosts = new Set<string>();
	for (const url of targetEndpointUrls(mode, config)) {
		try {
			hosts.add(new URL(url).host.toLowerCase());
		} catch {
			hosts.add(url);
		}
	}
	return hosts;
}

/** The cost one run is expected to add, used for budget checks before anything is sent. */
export function estimatedCostPerRun(mode: GeoSurfaceMode, config: unknown): number {
	const record = asRecord(config) ?? {};
	if (mode === "LIVE_SURFACE") return typeof record.costPerRequest === "number" ? record.costPerRequest : 0;
	if (mode !== "MODEL_API") return 0;
	const pricing = asRecord(record.pricing) ?? {};
	const perRequest = typeof pricing.perRequest === "number" ? pricing.perRequest : 0;
	const input = typeof pricing.inputPer1k === "number" ? pricing.inputPer1k * 0.2 : 0;
	const output = typeof pricing.outputPer1k === "number" ? pricing.outputPer1k * 1.5 : 0;
	return perRequest + input + output;
}
