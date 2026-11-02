import { createHash } from "node:crypto";
import { GEO_PLATFORM_LABELS, GEO_PLATFORMS, type GeoPlatform } from "@workspace/geo-domain";
import { captureFailure } from "./classify";
import { isHttpUrl } from "./http";
import type { CaptureCapabilities, CaptureCitation, CaptureResult, GeoCaptureAdapter } from "./types";

export const MANUAL_SOURCE_METHOD_VERSION = "manual-evidence/1";

/** A manual target is never sampled automatically: every planned run for it waits for an import. */
export class ManualEvidenceAdapter implements GeoCaptureAdapter {
	async capabilities(): Promise<CaptureCapabilities> {
		return { available: true, mode: "MANUAL_EVIDENCE", detail: "通过人工导入证据采样" };
	}

	async capture(): Promise<CaptureResult> {
		const failure = captureFailure("MANUAL_ONLY", "MANUAL_ONLY", "人工证据目标只能通过导入采样");
		return {
			status: "UNAVAILABLE",
			sampledAt: new Date().toISOString(),
			surfaceMode: "MANUAL_EVIDENCE",
			providerVersion: MANUAL_SOURCE_METHOD_VERSION,
			failure,
			errorCode: failure.code,
		};
	}
}

export const MANUAL_IMPORT_MAX_ROWS = 1000;
export const MANUAL_RESPONSE_MAX_CHARS = 100_000;
const MAX_EVIDENCE_LOCATION = 2000;
const FUTURE_TOLERANCE_MS = 5 * 60_000;
const EARLIEST_SAMPLE = Date.parse("2020-01-01T00:00:00Z");

/** Column headers a spreadsheet may use, mapped to the import's field names. */
export const MANUAL_IMPORT_COLUMNS: Record<string, keyof ManualImportRowInput> = {
	sampled_at: "sampledAt",
	sampledat: "sampledAt",
	采样时间: "sampledAt",
	时间: "sampledAt",
	platform: "platform",
	平台: "platform",
	question: "question",
	问题: "question",
	问法: "question",
	prompt_id: "promptId",
	promptid: "promptId",
	问法id: "promptId",
	response_text: "responseText",
	responsetext: "responseText",
	回答原文: "responseText",
	回答: "responseText",
	evidence_location: "evidenceLocation",
	evidencelocation: "evidenceLocation",
	证据位置: "evidenceLocation",
	citations: "citations",
	引用链接: "citations",
	引用: "citations",
	model_version: "modelVersion",
	modelversion: "modelVersion",
	模型版本: "modelVersion",
	target_id: "targetId",
	targetid: "targetId",
	目标id: "targetId",
	status: "status",
	状态: "status",
	note: "note",
	备注: "note",
};

export interface ManualImportRowInput {
	sampledAt?: unknown;
	platform?: unknown;
	question?: unknown;
	promptId?: unknown;
	responseText?: unknown;
	evidenceLocation?: unknown;
	citations?: unknown;
	modelVersion?: unknown;
	targetId?: unknown;
	status?: unknown;
	note?: unknown;
}

export interface ManualImportRow {
	/** One-based, as a person counts rows in the file they uploaded. */
	row: number;
	sampledAt: Date;
	platform: GeoPlatform;
	question: string | null;
	promptId: string | null;
	responseText: string;
	evidenceLocation: string;
	citations: CaptureCitation[];
	modelVersion: string | null;
	targetId: string | null;
	status: "VALID" | "PARTIAL";
	note: string | null;
}

export interface ManualRowError {
	row: number;
	field: string;
	code: "EVIDENCE_REQUIRED" | "VALIDATION_ERROR";
	message: string;
}

export function normalizeCsvRecord(record: Record<string, string>): ManualImportRowInput {
	const input: ManualImportRowInput = {};
	for (const [header, value] of Object.entries(record)) {
		const field = MANUAL_IMPORT_COLUMNS[header.trim().toLowerCase().replace(/\s+/g, "_")];
		if (field && value !== undefined && value !== "") input[field] = value;
	}
	return input;
}

const PLATFORM_ALIASES: Record<string, GeoPlatform> = {
	元宝: "yuanbao",
	腾讯元宝: "yuanbao",
	通义: "qwen",
	千问: "qwen",
	通义千问: "qwen",
	tongyi: "qwen",
	deepseek: "deepseek",
	深度求索: "deepseek",
	豆包: "doubao",
};

export function parsePlatform(value: unknown): GeoPlatform | null {
	if (typeof value !== "string") return null;
	const key = value.trim().toLowerCase();
	if ((GEO_PLATFORMS as readonly string[]).includes(key)) return key as GeoPlatform;
	const byLabel = GEO_PLATFORMS.find((platform) => GEO_PLATFORM_LABELS[platform].toLowerCase() === key);
	return byLabel ?? PLATFORM_ALIASES[key] ?? PLATFORM_ALIASES[value.trim()] ?? null;
}

const LOCAL_DATE_TIME = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;

/** A time without a zone is read as China Standard Time, which is where manual samples are taken. */
export function parseSampledAt(value: unknown): Date | null {
	if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
	if (typeof value !== "string" || !value.trim()) return null;
	const text = value.trim();
	const local = LOCAL_DATE_TIME.exec(text);
	if (local) {
		const [, y, mo, d, h = "0", mi = "0", s = "0"] = local;
		const iso = `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}T${h.padStart(2, "0")}:${mi}:${s.padStart(2, "0")}+08:00`;
		const date = new Date(iso);
		return Number.isNaN(date.getTime()) ? null : date;
	}
	if (!/^\d{4}-\d{2}-\d{2}T/.test(text)) return null;
	const date = new Date(text);
	return Number.isNaN(date.getTime()) ? null : date;
}

function citationItems(value: unknown): unknown[] {
	if (value === undefined || value === null || value === "") return [];
	return Array.isArray(value)
		? value
		: String(value)
				.split(/[\s;；,，]+/)
				.filter(Boolean);
}

function citationOf(item: unknown): { url: unknown; title: unknown } {
	if (typeof item === "object" && item) return item as { url: unknown; title: unknown };
	return { url: item, title: undefined };
}

function parseCitations(value: unknown): { citations: CaptureCitation[]; invalid: string[] } {
	const citations: CaptureCitation[] = [];
	const invalid: string[] = [];
	const seen = new Set<string>();
	for (const item of citationItems(value)) {
		const { url, title } = citationOf(item);
		if (!isHttpUrl(url)) invalid.push(String(url).slice(0, 80));
		else if (!seen.has(url)) {
			seen.add(url);
			citations.push(typeof title === "string" && title.trim() ? { url, title: title.trim().slice(0, 500) } : { url });
		}
	}
	return { citations, invalid };
}

function optionalText(value: unknown, max: number): string | null {
	if (typeof value !== "string" && typeof value !== "number") return null;
	const text = String(value).trim();
	return text ? text.slice(0, max) : null;
}

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UPLOAD_REF = /^upload:[0-9a-f]{64}\.[a-z0-9]{2,5}$/;

export function isUploadedEvidenceRef(value: string): boolean {
	return UPLOAD_REF.test(value);
}

type FieldCheck<T> = { value: T | null; errors: Omit<ManualRowError, "row">[] };

const missing = (field: string, label: string): Omit<ManualRowError, "row"> => ({
	field,
	code: "EVIDENCE_REQUIRED",
	message: `缺少${label}`,
});
const malformed = (field: string, message: string): Omit<ManualRowError, "row"> => ({
	field,
	code: "VALIDATION_ERROR",
	message,
});

function isBlank(value: unknown): boolean {
	return value === undefined || value === null || (typeof value === "string" && !value.trim());
}

function checkSampledAt(value: unknown, now: Date): FieldCheck<Date> {
	if (isBlank(value)) return { value: null, errors: [missing("sampledAt", "采样时间")] };
	const date = parseSampledAt(value);
	if (!date)
		return {
			value: null,
			errors: [malformed("sampledAt", "采样时间格式无法识别，请使用 2026-11-02 08:00 或 ISO 8601")],
		};
	if (date.getTime() > now.getTime() + FUTURE_TOLERANCE_MS)
		return { value: null, errors: [malformed("sampledAt", "采样时间晚于当前时间")] };
	if (date.getTime() < EARLIEST_SAMPLE) return { value: null, errors: [malformed("sampledAt", "采样时间过早")] };
	return { value: date, errors: [] };
}

function checkPlatform(value: unknown): FieldCheck<GeoPlatform> {
	if (isBlank(value)) return { value: null, errors: [missing("platform", "平台")] };
	const platform = parsePlatform(value);
	return platform
		? { value: platform, errors: [] }
		: { value: null, errors: [malformed("platform", "平台无法识别，可用值：豆包、DeepSeek、腾讯元宝、通义千问")] };
}

function checkQuestion(input: ManualImportRowInput): FieldCheck<{ question: string | null; promptId: string | null }> {
	const question = optionalText(input.question, 2000);
	const promptId = optionalText(input.promptId, 64);
	if (!question && !promptId) return { value: null, errors: [missing("question", "问题")] };
	if (promptId && !UUID_SHAPE.test(promptId))
		return { value: null, errors: [malformed("promptId", "问法 ID 格式无效")] };
	return { value: { question, promptId }, errors: [] };
}

function checkResponseText(value: unknown): FieldCheck<string> {
	const text = typeof value === "string" ? value : "";
	if (!text.trim()) return { value: null, errors: [missing("responseText", "回答原文")] };
	if (text.length > MANUAL_RESPONSE_MAX_CHARS) {
		return { value: null, errors: [malformed("responseText", `回答原文超过 ${MANUAL_RESPONSE_MAX_CHARS} 字`)] };
	}
	return { value: text, errors: [] };
}

const SCHEME = /^[a-z][a-z0-9+.-]+:/i;

function checkEvidenceLocation(value: unknown): FieldCheck<string> {
	const location = optionalText(value, MAX_EVIDENCE_LOCATION + 1);
	if (!location) return { value: null, errors: [missing("evidenceLocation", "证据位置")] };
	if (location.length > MAX_EVIDENCE_LOCATION)
		return { value: null, errors: [malformed("evidenceLocation", "证据位置过长")] };
	if (SCHEME.test(location) && !isHttpUrl(location) && !isUploadedEvidenceRef(location)) {
		return {
			value: null,
			errors: [malformed("evidenceLocation", "证据位置只能是 http(s) 链接、已上传的证据文件或存档说明")],
		};
	}
	return { value: location, errors: [] };
}

function checkStatus(value: unknown): FieldCheck<"VALID" | "PARTIAL"> {
	const text = optionalText(value, 20)?.toLowerCase();
	if (!text || text === "valid" || text === "有效") return { value: "VALID", errors: [] };
	if (text === "partial" || text === "部分" || text === "部分成功") return { value: "PARTIAL", errors: [] };
	return { value: null, errors: [malformed("status", "状态只能是 VALID（有效）或 PARTIAL（部分成功）")] };
}

function checkTargetId(value: unknown): FieldCheck<string | null> {
	const targetId = optionalText(value, 64);
	if (targetId && !UUID_SHAPE.test(targetId))
		return { value: null, errors: [malformed("targetId", "目标 ID 格式无效")] };
	return { value: targetId, errors: [] };
}

function checkRow(raw: unknown, row: number, now: Date): { row: ManualImportRow | null; errors: ManualRowError[] } {
	const input = (raw && typeof raw === "object" ? raw : {}) as ManualImportRowInput;
	const sampledAt = checkSampledAt(input.sampledAt, now);
	const platform = checkPlatform(input.platform);
	const question = checkQuestion(input);
	const responseText = checkResponseText(input.responseText);
	const evidenceLocation = checkEvidenceLocation(input.evidenceLocation);
	const citations = parseCitations(input.citations);
	const targetId = checkTargetId(input.targetId);
	const status = checkStatus(input.status);
	const errors = [
		...sampledAt.errors,
		...platform.errors,
		...question.errors,
		...responseText.errors,
		...evidenceLocation.errors,
		...(citations.invalid.length
			? [malformed("citations", `引用链接无效：${citations.invalid.slice(0, 3).join("、")}`)]
			: []),
		...targetId.errors,
		...status.errors,
	].map((error) => ({ ...error, row }));
	if (
		errors.length ||
		!sampledAt.value ||
		!platform.value ||
		!question.value ||
		!responseText.value ||
		!evidenceLocation.value ||
		!status.value
	) {
		return { row: null, errors };
	}
	return {
		row: {
			row,
			sampledAt: sampledAt.value,
			platform: platform.value,
			question: question.value.question,
			promptId: question.value.promptId,
			responseText: responseText.value,
			evidenceLocation: evidenceLocation.value,
			citations: citations.citations,
			modelVersion: optionalText(input.modelVersion, 200),
			targetId: targetId.value,
			status: status.value,
			note: optionalText(input.note, 1000),
		},
		errors,
	};
}

/**
 * Checks every row and reports every problem, so a person can fix a file in one pass.
 * Time, platform, question, answer text and evidence location are all mandatory:
 * an answer nobody can trace back to where it was seen is not evidence.
 */
export function validateManualRows(
	inputs: readonly unknown[],
	now: Date = new Date(),
): { rows: ManualImportRow[]; errors: ManualRowError[] } {
	if (inputs.length === 0) {
		return { rows: [], errors: [{ row: 0, field: "rows", code: "EVIDENCE_REQUIRED", message: "没有可导入的记录" }] };
	}
	if (inputs.length > MANUAL_IMPORT_MAX_ROWS) {
		return {
			rows: [],
			errors: [
				{ row: 0, field: "rows", code: "VALIDATION_ERROR", message: `单次最多导入 ${MANUAL_IMPORT_MAX_ROWS} 条` },
			],
		};
	}
	const rows: ManualImportRow[] = [];
	const errors: ManualRowError[] = [];
	inputs.forEach((raw, index) => {
		const checked = checkRow(raw, index + 1, now);
		if (checked.row) rows.push(checked.row);
		errors.push(...checked.errors);
	});
	return { rows, errors };
}

/** The error code for a failed import: missing evidence wins over malformed values. */
export function manualImportErrorCode(errors: readonly ManualRowError[]): "EVIDENCE_REQUIRED" | "VALIDATION_ERROR" {
	return errors.some((error) => error.code === "EVIDENCE_REQUIRED") ? "EVIDENCE_REQUIRED" : "VALIDATION_ERROR";
}

/** Same platform, question, time and answer is the same piece of evidence, however many times it is uploaded. */
export function manualImportFingerprint(input: {
	organizationId: string;
	targetId: string;
	promptId: string;
	sampledAt: Date;
	responseText: string;
}): string {
	return createHash("sha256")
		.update(
			[input.organizationId, input.targetId, input.promptId, input.sampledAt.toISOString(), input.responseText].join(
				"\u0000",
			),
		)
		.digest("hex");
}
