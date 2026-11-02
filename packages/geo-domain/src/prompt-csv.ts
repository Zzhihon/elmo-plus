import { GEO_PRIORITIES, GEO_PROMPT_TIERS, type GeoPriority, type GeoPromptStatus, type GeoPromptTier } from "./enums";

export const GEO_PROMPT_CSV_COLUMNS = [
	"prompt_id",
	"question",
	"buyer_role",
	"intent",
	"product_line",
	"geo_region",
	"priority",
	"language",
	"tier",
	"status",
	"test_set_version",
	"owner",
] as const;
export type GeoPromptCsvColumn = (typeof GEO_PROMPT_CSV_COLUMNS)[number];

export const GEO_PROMPT_CSV_MAX_ROWS = 2000;
export const GEO_PROMPT_QUESTION_MAX_LENGTH = 500;

const REQUIRED_COLUMNS: readonly GeoPromptCsvColumn[] = ["question"];
const LANGUAGE_SHAPE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Spreadsheets also evaluate the full-width forms, and tab or CR can hide what follows them.
const FORMULA_LEAD = /^[\s　]*[=+\-@＝＋－＠]|^[\t\r\n]/;

export function looksLikeSpreadsheetFormula(value: string): boolean {
	return FORMULA_LEAD.test(value);
}

export function neutralizeCsvCell(value: string): string {
	return looksLikeSpreadsheetFormula(value) ? `'${value}` : value;
}

function quoteCsvCell(value: string): string {
	return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** The leading BOM is what makes Excel read the file as UTF-8 rather than mangle the Chinese. */
export function toPromptCsv(rows: readonly Record<GeoPromptCsvColumn, string>[]): string {
	const lines = [
		GEO_PROMPT_CSV_COLUMNS.join(","),
		...rows.map((row) =>
			GEO_PROMPT_CSV_COLUMNS.map((column) => quoteCsvCell(neutralizeCsvCell(row[column] ?? ""))).join(","),
		),
	];
	return `﻿${lines.join("\r\n")}\r\n`;
}

export function normalizePromptQuestion(question: string): string {
	return question.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}

export interface GeoPromptCsvRowInput {
	line: number;
	cells: Partial<Record<string, string>>;
}

export interface GeoPromptCsvError {
	line: number;
	column: GeoPromptCsvColumn | null;
	message: string;
}

export interface GeoPromptCsvValidRow {
	line: number;
	promptId: string | null;
	question: string;
	buyerRoleId: string | null;
	intent: string | null;
	productLine: string | null;
	geoRegion: string | null;
	priority: GeoPriority;
	language: string;
	tier: GeoPromptTier;
	ownerId: string | null;
}

export interface GeoPromptCsvExisting {
	id: string;
	question: string;
	status: GeoPromptStatus;
	buyerRoleId: string | null;
	intent: string | null;
	productLine: string | null;
	geoRegion: string | null;
	priority: GeoPriority;
	language: string;
	tier: GeoPromptTier;
	ownerId: string | null;
}

export interface GeoPromptCsvContext {
	/** Each role under both its code and its title; callers build it with `promptCsvRoleLookup`. */
	roles: ReadonlyMap<string, string>;
	existing: readonly GeoPromptCsvExisting[];
	memberIds: ReadonlySet<string>;
}

export function promptCsvRoleLookup(
	roles: readonly { id: string; code: string; title: string }[],
): ReadonlyMap<string, string> {
	return new Map(roles.flatMap((role) => [[role.code, role.id] as const, [role.title, role.id] as const]));
}

export function missingPromptCsvColumns(header: readonly string[]): GeoPromptCsvColumn[] {
	return REQUIRED_COLUMNS.filter((column) => !header.includes(column));
}

const FREE_TEXT_FIELDS = {
	question: "question",
	intent: "intent",
	product_line: "productLine",
	geo_region: "geoRegion",
} as const;
const FREE_TEXT_COLUMNS = ["question", "intent", "product_line", "geo_region"] as const;

type Report = (column: GeoPromptCsvColumn | null, message: string) => void;
type Cells = (column: GeoPromptCsvColumn) => string;

interface FileState {
	existingById: Map<string, GeoPromptCsvContext["existing"][number]>;
	questionOwners: Map<string, string>;
	seenInFile: Map<string, number>;
}

/** Export guards a formula-like cell with a leading apostrophe; reading it back removes the guard. */
function freeText(cell: Cells, column: (typeof FREE_TEXT_COLUMNS)[number]): string | null {
	return cell(column).replace(/^'/, "") || null;
}

/** Refuses formula-like text coming in; what the library already holds came back from an export, not from here. */
function checkFormulas(cell: Cells, existing: GeoPromptCsvExisting | undefined, report: Report) {
	for (const column of FREE_TEXT_COLUMNS) {
		const value = cell(column).replace(/^'/, "");
		if (value === existing?.[FREE_TEXT_FIELDS[column]]) continue;
		if (looksLikeSpreadsheetFormula(value)) report(column, "内容以公式字符开头（= + - @），已拒绝导入");
	}
}

function checkQuestion(question: string, report: Report) {
	if (!question) report("question", "问法不能为空");
	else if (question.length > GEO_PROMPT_QUESTION_MAX_LENGTH) {
		report("question", `问法不能超过 ${GEO_PROMPT_QUESTION_MAX_LENGTH} 字`);
	}
}

function checkPromptId(promptId: string | null, state: FileState, report: Report) {
	if (!promptId) return;
	const existing = UUID_SHAPE.test(promptId) ? state.existingById.get(promptId) : undefined;
	if (!existing) report("prompt_id", "问法不存在");
}

const COMPARED_FIELDS = [
	"question",
	"buyerRoleId",
	"intent",
	"productLine",
	"geoRegion",
	"priority",
	"language",
	"tier",
	"ownerId",
] as const;

function matchesExisting(row: GeoPromptCsvValidRow, existing: GeoPromptCsvExisting): boolean {
	return COMPARED_FIELDS.every((field) => (row[field] ?? null) === (existing[field]?.trim() || null));
}

function checkDuplicate(line: number, question: string, promptId: string | null, state: FileState, report: Report) {
	const key = normalizePromptQuestion(question);
	if (!key) return;
	const firstLine = state.seenInFile.get(key);
	if (firstLine !== undefined) report("question", `与第 ${firstLine} 行问法重复`);
	else state.seenInFile.set(key, line);
	const owner = state.questionOwners.get(key);
	if (owner && owner !== promptId) report("question", "问法库中已存在相同问法");
}

function readLabels(cell: Cells, context: GeoPromptCsvContext, report: Report) {
	const roleName = cell("buyer_role");
	const buyerRoleId = roleName ? (context.roles.get(roleName) ?? null) : null;
	if (roleName && !buyerRoleId) report("buyer_role", `未知买方角色“${roleName}”`);

	const priority = (cell("priority") || "P2") as GeoPriority;
	if (!GEO_PRIORITIES.includes(priority)) report("priority", `优先级必须是 ${GEO_PRIORITIES.join(" / ")}`);

	const tier = (cell("tier") || "CORE") as GeoPromptTier;
	if (!GEO_PROMPT_TIERS.includes(tier)) report("tier", `层级必须是 ${GEO_PROMPT_TIERS.join(" / ")}`);

	const language = cell("language") || "zh-CN";
	if (!LANGUAGE_SHAPE.test(language)) report("language", "语言代码格式无效，例如 zh-CN");

	const ownerId = cell("owner") || null;
	if (ownerId && !context.memberIds.has(ownerId)) report("owner", "负责人不是本组织成员");

	return { buyerRoleId, priority, tier, language, ownerId };
}

/**
 * The whole file is checked at once so every problem can be fixed in one pass.
 * `status` and `test_set_version` appear in exports but are never read back: a status
 * only ever changes through review, and a spreadsheet must not be a way around it. So an
 * exported file can come straight back: reviewed rows that still match are only counted,
 * and only a reviewed row someone actually changed is an error.
 */
export function validatePromptCsvRows(
	rows: readonly GeoPromptCsvRowInput[],
	context: GeoPromptCsvContext,
): { valid: GeoPromptCsvValidRow[]; unchanged: number[]; errors: GeoPromptCsvError[] } {
	const valid: GeoPromptCsvValidRow[] = [];
	const unchanged: number[] = [];
	const errors: GeoPromptCsvError[] = [];
	const state: FileState = {
		existingById: new Map(context.existing.map((prompt) => [prompt.id, prompt])),
		questionOwners: new Map(context.existing.map((prompt) => [normalizePromptQuestion(prompt.question), prompt.id])),
		seenInFile: new Map(),
	};

	for (const { line, cells } of rows) {
		const before = errors.length;
		const report: Report = (column, message) => errors.push({ line, column, message });
		const cell: Cells = (column) => cells[column]?.trim() ?? "";

		const promptId = cell("prompt_id") || null;
		checkFormulas(cell, promptId ? state.existingById.get(promptId) : undefined, report);
		const question = cell("question").replace(/^'/, "");
		checkQuestion(question, report);
		checkPromptId(promptId, state, report);
		checkDuplicate(line, question, promptId, state, report);
		const labels = readLabels(cell, context, report);

		if (errors.length > before) continue;
		const parsed: GeoPromptCsvValidRow = {
			line,
			promptId,
			question,
			intent: freeText(cell, "intent"),
			productLine: freeText(cell, "product_line"),
			geoRegion: freeText(cell, "geo_region"),
			...labels,
		};
		const existing = promptId ? state.existingById.get(promptId) : undefined;
		if (!existing || existing.status === "DRAFT") valid.push(parsed);
		else if (matchesExisting(parsed, existing)) unchanged.push(line);
		else report("prompt_id", "只有草稿状态的问法可以通过导入修改；这一行与问法库中的内容不一致");
	}
	return { valid, unchanged, errors };
}
