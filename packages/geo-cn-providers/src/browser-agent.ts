import { GEO_PLATFORMS, type GeoObservationStatus, type GeoPlatform } from "@workspace/geo-domain";
import { captureFailure } from "./classify";
import { isHttpUrl } from "./http";
import { isUploadedEvidenceRef, MANUAL_RESPONSE_MAX_CHARS, parseSampledAt } from "./manual";
import type { CaptureCapabilities, CaptureCitation, CaptureResult, GeoCaptureAdapter } from "./types";

export const BROWSER_AGENT_SOURCE_METHOD_VERSION = "browser-agent/1";

/** The answers come from an agent in the user's own browser and arrive by import; the worker never runs one. */
export class BrowserAgentAdapter implements GeoCaptureAdapter {
	async capabilities(): Promise<CaptureCapabilities> {
		return { available: true, mode: "BROWSER_AGENT", detail: "由浏览器代理在用户已登录的浏览器中提问后导入" };
	}

	async capture(): Promise<CaptureResult> {
		const failure = captureFailure("MANUAL_ONLY", "IMPORT_ONLY", "浏览器模拟用户目标只能通过导入采样");
		return {
			status: "UNAVAILABLE",
			sampledAt: new Date().toISOString(),
			surfaceMode: "BROWSER_AGENT",
			providerVersion: BROWSER_AGENT_SOURCE_METHOD_VERSION,
			failure,
			errorCode: failure.code,
		};
	}
}

const CHINA_OFFSET_MS = 8 * 3_600_000;
const DAY_MS = 86_400_000;
const PLAN_KEY = /^(\d{4})-W(\d{2})$/;

/** The ISO week a moment falls in on the China clock, e.g. "2026-W45": one sampling round. */
export function browserPlanKey(at: Date): string {
	const local = new Date(at.getTime() + CHINA_OFFSET_MS);
	const day = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
	const weekday = (local.getUTCDay() + 6) % 7;
	const thursday = new Date(day + (3 - weekday) * DAY_MS);
	const year = thursday.getUTCFullYear();
	const week = Math.floor((thursday.getTime() - Date.UTC(year, 0, 1)) / DAY_MS / 7) + 1;
	return `${year}-W${String(week).padStart(2, "0")}`;
}

/** Monday 00:00 to the next Monday 00:00, China time, or null for a key that names no week. */
export function browserPlanWindow(planKey: string): { from: Date; to: Date } | null {
	const match = PLAN_KEY.exec(planKey);
	if (!match) return null;
	const year = Number(match[1]);
	const week = Number(match[2]);
	const jan4 = Date.UTC(year, 0, 4);
	const week1Monday = jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * DAY_MS;
	const monday = week1Monday + (week - 1) * 7 * DAY_MS;
	const from = new Date(monday - CHINA_OFFSET_MS);
	if (week < 1 || browserPlanKey(from) !== planKey) return null;
	return { from, to: new Date(from.getTime() + 7 * DAY_MS) };
}

export const BROWSER_FAILURE_CODES = [
	"CAPTCHA",
	"LOGIN_REQUIRED",
	"RATE_LIMITED",
	"TIMEOUT",
	"REGION_BLOCKED",
	"UI_CHANGED",
	"EMPTY_ANSWER",
	"OTHER",
] as const;
export type BrowserFailureCode = (typeof BROWSER_FAILURE_CODES)[number];

/** A run that produced no answer keeps the status the automatic captures use for the same cause. */
const STATUS_BY_FAILURE: Record<BrowserFailureCode, GeoObservationStatus> = {
	CAPTCHA: "CAPTCHA",
	LOGIN_REQUIRED: "NEEDS_MANUAL",
	RATE_LIMITED: "RATE_LIMITED",
	TIMEOUT: "TIMEOUT",
	REGION_BLOCKED: "UNAVAILABLE",
	UI_CHANGED: "FAILED",
	EMPTY_ANSWER: "FAILED",
	OTHER: "FAILED",
};

export const BROWSER_IMPORT_MAX_ROWS = 500;
const MAX_EVIDENCE_REFS = 10;
const FUTURE_TOLERANCE_MS = 5 * 60_000;

export interface BrowserSession {
	account?: string;
	loggedIn?: boolean;
	deepThinking?: boolean;
	webSearch?: boolean;
	region?: string;
}

interface BrowserRowBase {
	runKey: string;
	platform: GeoPlatform;
	promptId: string;
	repeatIndex: number;
	question: string;
	sampledAt: Date;
	evidenceRefs: string[];
	modelVersion: string | null;
	session: BrowserSession;
	note: string | null;
}

export type BrowserImportRow =
	| (BrowserRowBase & {
			status: "VALID" | "PARTIAL";
			responseText: string;
			citations: CaptureCitation[];
			droppedCitations: number;
	  })
	| (BrowserRowBase & {
			status: "FAILED";
			observationStatus: GeoObservationStatus;
			failure: { code: BrowserFailureCode; message: string | null };
	  });

export interface BrowserRowError {
	runKey: string;
	field: string;
	message: string;
}

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RUN_KEY = /^(\d{4}-W\d{2})\/([a-z]+)\/([0-9a-f-]{36})\/(\d{1,2})$/i;

function text(value: unknown, max: number): string | null {
	return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function parseSession(value: unknown): BrowserSession {
	const input = record(value);
	const session: BrowserSession = {};
	const account = text(input.account, 100);
	const region = text(input.region, 20);
	if (account) session.account = account;
	if (region) session.region = region;
	for (const key of ["loggedIn", "deepThinking", "webSearch"] as const) {
		if (typeof input[key] === "boolean") session[key] = input[key];
	}
	return session;
}

function parseCitations(value: unknown): { citations: CaptureCitation[]; dropped: number } {
	const citations: CaptureCitation[] = [];
	const seen = new Set<string>();
	let dropped = 0;
	for (const item of Array.isArray(value) ? value : []) {
		const { url, title } = record(item);
		if (!isHttpUrl(url) || url.length > 2000) dropped += 1;
		else if (!seen.has(url)) {
			seen.add(url);
			const name = text(title, 500);
			citations.push(name ? { url, title: name } : { url });
		}
	}
	return { citations, dropped };
}

function checkSampledAt(value: unknown, now: Date, window: { from: Date; to: Date }): Date | string {
	const at = parseSampledAt(value);
	if (!at) return "采样时间缺失或格式无法识别，请使用 ISO 8601";
	if (at.getTime() > now.getTime() + FUTURE_TOLERANCE_MS) return "采样时间晚于当前时间";
	if (at < window.from || at >= window.to) return "采样时间不在该周计划内";
	return at;
}

function checkRunKey(
	input: Record<string, unknown>,
	planKey: string,
	repeats: number,
): { runKey: string; repeatIndex: number } | BrowserRowError {
	const runKey = typeof input.runKey === "string" ? input.runKey.trim() : "";
	const fail = (field: string, message: string): BrowserRowError => ({ runKey, field, message });
	const match = RUN_KEY.exec(runKey);
	if (!match) return fail("runKey", "runKey 应为 <planKey>/<platform>/<promptId>/<repeat>");
	if (input.planKey !== planKey || match[1] !== planKey) return fail("planKey", `不属于本次计划 ${planKey}`);
	if (match[2] !== input.platform) return fail("runKey", "runKey 中的平台与 platform 不一致");
	if (match[3].toLowerCase() !== String(input.promptId).toLowerCase()) {
		return fail("runKey", "runKey 中的问法 ID 与 promptId 不一致");
	}
	const repeatIndex = Number(match[4]);
	if (repeatIndex < 1 || repeatIndex > repeats) return fail("runKey", `重复序号应在 1–${repeats} 之间`);
	return { runKey, repeatIndex };
}

function checkRow(raw: unknown, index: number, plan: BrowserPlanRules, now: Date): BrowserImportRow | BrowserRowError {
	const input = record(raw);
	const key = typeof input.runKey === "string" && input.runKey.trim() ? input.runKey.trim() : `#${index + 1}`;
	const fail = (field: string, message: string): BrowserRowError => ({ runKey: key, field, message });

	if (!(GEO_PLATFORMS as readonly unknown[]).includes(input.platform)) return fail("platform", "平台无效");
	const platform = input.platform as GeoPlatform;
	if (typeof input.promptId !== "string" || !UUID_SHAPE.test(input.promptId)) {
		return fail("promptId", "问法 ID 格式无效");
	}
	const promptId = input.promptId.toLowerCase();
	const repeats = plan.repeatsByPlatform.get(platform);
	if (repeats === undefined) return fail("platform", "该平台没有已启用的浏览器模拟用户目标");
	if (!plan.promptIds.has(promptId)) return fail("promptId", "问法不在本次计划的问法集中");
	const run = checkRunKey(input, plan.planKey, repeats);
	if ("field" in run) return run;
	const question = text(input.question, 2000);
	if (!question) return fail("question", "缺少实际提问的问题文字");
	const sampledAt = checkSampledAt(input.sampledAt, now, plan.window);
	if (typeof sampledAt === "string") return fail("sampledAt", sampledAt);

	const refs = Array.isArray(input.evidenceRefs) ? input.evidenceRefs : [];
	if (refs.length > MAX_EVIDENCE_REFS) return fail("evidenceRefs", `每条最多 ${MAX_EVIDENCE_REFS} 个证据文件`);
	if (refs.some((ref) => typeof ref !== "string" || !isUploadedEvidenceRef(ref))) {
		return fail("evidenceRefs", "证据引用无效，应为 geo_upload_evidence 返回的 evidenceRef");
	}
	const base: BrowserRowBase = {
		runKey: run.runKey,
		platform,
		promptId,
		repeatIndex: run.repeatIndex,
		question,
		sampledAt,
		evidenceRefs: [...new Set(refs as string[])],
		modelVersion: text(input.modelVersion, 200),
		session: parseSession(input.session),
		note: text(input.note, 1000),
	};

	if (input.status === "FAILED") {
		const failure = record(input.failure);
		if (!(BROWSER_FAILURE_CODES as readonly unknown[]).includes(failure.code)) {
			return fail("failure.code", `失败原因应为 ${BROWSER_FAILURE_CODES.join("、")} 之一`);
		}
		const code = failure.code as BrowserFailureCode;
		return {
			...base,
			status: "FAILED",
			observationStatus: STATUS_BY_FAILURE[code],
			failure: { code, message: text(failure.message, 500) },
		};
	}
	if (input.status !== "VALID" && input.status !== "PARTIAL")
		return fail("status", "状态只能是 VALID、PARTIAL 或 FAILED");
	const responseText = typeof input.responseText === "string" ? input.responseText : "";
	if (!responseText.trim()) return fail("responseText", "有回答的记录必须附回答原文");
	if (responseText.length > MANUAL_RESPONSE_MAX_CHARS) {
		return fail("responseText", `回答原文超过 ${MANUAL_RESPONSE_MAX_CHARS} 字`);
	}
	if (base.evidenceRefs.length === 0) return fail("evidenceRefs", "有回答的记录至少要附一张截图");
	const { citations, dropped } = parseCitations(input.citations);
	return { ...base, status: input.status, responseText, citations, droppedCitations: dropped };
}

export interface BrowserPlanRules {
	planKey: string;
	window: { from: Date; to: Date };
	promptIds: ReadonlySet<string>;
	/** Platforms with an enabled browser-agent target, and how many repeats each asks for. */
	repeatsByPlatform: ReadonlyMap<GeoPlatform, number>;
}

/**
 * Checks each row on its own: a weekly run is long, so one bad row is reported back
 * by its runKey rather than holding up the answers that were captured fine.
 */
export function validateBrowserRows(
	inputs: readonly unknown[],
	plan: BrowserPlanRules,
	now: Date = new Date(),
): { rows: BrowserImportRow[]; errors: BrowserRowError[] } {
	const rows: BrowserImportRow[] = [];
	const errors: BrowserRowError[] = [];
	const seen = new Set<string>();
	inputs.forEach((raw, index) => {
		const checked = checkRow(raw, index, plan, now);
		if ("field" in checked) errors.push(checked);
		else if (seen.has(checked.runKey))
			errors.push({ runKey: checked.runKey, field: "runKey", message: "同一批中 runKey 重复" });
		else {
			seen.add(checked.runKey);
			rows.push(checked);
		}
	});
	return { rows, errors };
}
