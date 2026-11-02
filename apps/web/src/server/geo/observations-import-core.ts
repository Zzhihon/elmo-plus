import { createHash, randomUUID } from "node:crypto";
import {
	isUploadedEvidenceRef,
	MANUAL_SOURCE_METHOD_VERSION,
	type ManualImportRow,
	type ManualRowError,
	manualImportErrorCode,
	manualImportFingerprint,
	normalizeCsvRecord,
	validateManualRows,
} from "@workspace/geo-cn-providers";
import {
	assertGeoPermission,
	GEO_EVALUATE_OBSERVATION_QUEUE,
	GeoError,
	type GeoPrincipal,
	isEvaluableObservation,
} from "@workspace/geo-domain";
import { geoObjectKey, getObjectStore, hostOf, normalizeUrl } from "@workspace/geo-evidence";
import { db } from "@workspace/lib/db/db";
import {
	geoObservationCitations,
	geoObservations,
	geoPromptSetItems,
	geoPromptSets,
	geoPrompts,
	geoSamplingTargets,
} from "@workspace/lib/db/schema";
import { writeGeoAudit } from "@workspace/lib/geo/audit";
import { parse as parseCsv } from "csv-parse/sync";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { enqueueGeoJob } from "@/lib/geo/enqueue";

const MAX_CONTENT_CHARS = 5 * 1024 * 1024;

export const manualImportInputSchema = z.discriminatedUnion("format", [
	z.object({ format: z.literal("rows"), rows: z.array(z.unknown()).max(1000), promptSetId: z.guid().optional() }),
	z.object({
		format: z.enum(["csv", "json"]),
		content: z.string().max(MAX_CONTENT_CHARS, "文件过大，单次最多 5 MB"),
		promptSetId: z.guid().optional(),
	}),
]);
export type ManualImportInput = z.infer<typeof manualImportInputSchema>;

export type ManualImportResult =
	| {
			ok: true;
			importBatchId: string;
			created: number;
			skipped: number;
			observationIds: string[];
			skippedRows: number[];
	  }
	| { ok: false; code: "EVIDENCE_REQUIRED" | "VALIDATION_ERROR"; message: string; errors: ManualRowError[] };

function rejected(errors: ManualRowError[]): ManualImportResult {
	const code = manualImportErrorCode(errors);
	return {
		ok: false,
		code,
		message:
			code === "EVIDENCE_REQUIRED"
				? "导入记录缺少必需的证据字段：采样时间、平台、问题、回答原文和证据位置均为必填"
				: "导入记录存在格式错误",
		errors,
	};
}

function parseContent(input: ManualImportInput): { rows: unknown[] } | { error: ManualRowError } {
	if (input.format === "rows") return { rows: input.rows };
	try {
		if (input.format === "json") {
			const parsed: unknown = JSON.parse(input.content);
			const rows = Array.isArray(parsed) ? parsed : (parsed as { rows?: unknown })?.rows;
			if (!Array.isArray(rows)) throw new Error("not an array");
			return { rows };
		}
		const records = parseCsv(input.content, {
			columns: true,
			bom: true,
			skip_empty_lines: true,
			trim: true,
			relax_column_count: true,
		}) as Record<string, string>[];
		return { rows: records.map(normalizeCsvRecord) };
	} catch {
		const message =
			input.format === "json" ? "JSON 无法解析，应为记录数组或 { rows: [...] }" : "CSV 无法解析，请检查表头与引号";
		return { error: { row: 0, field: "content", code: "VALIDATION_ERROR", message } };
	}
}

function normalizeQuestion(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

interface ResolvedPrompt {
	promptId: string;
	revision: number;
	questionText: string;
	promptSetId: string | null;
}

interface PromptCandidate {
	id: string;
	question: string;
	revision: number;
}

async function promptCandidates(organizationId: string, promptSetId: string | undefined): Promise<PromptCandidate[]> {
	if (promptSetId) {
		return db
			.select({
				id: geoPromptSetItems.promptId,
				question: geoPromptSetItems.questionText,
				revision: geoPromptSetItems.promptRevision,
			})
			.from(geoPromptSetItems)
			.where(and(eq(geoPromptSetItems.setId, promptSetId), eq(geoPromptSetItems.organizationId, organizationId)));
	}
	return db
		.select({ id: geoPrompts.id, question: geoPrompts.question, revision: geoPrompts.currentRevision })
		.from(geoPrompts)
		.where(eq(geoPrompts.organizationId, organizationId));
}

function promptIndex(candidates: PromptCandidate[]) {
	const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
	const byText = new Map<string, PromptCandidate[]>();
	for (const candidate of candidates) {
		const key = normalizeQuestion(candidate.question);
		byText.set(key, [...(byText.get(key) ?? []), candidate]);
	}
	return (row: ManualImportRow): PromptCandidate[] => {
		if (row.promptId) {
			const match = byId.get(row.promptId);
			return match ? [match] : [];
		}
		return byText.get(normalizeQuestion(row.question ?? "")) ?? [];
	};
}

/** Matches each row to a question in the library, by id or by exact text; ambiguity is an error, not a guess. */
async function resolvePrompts(
	organizationId: string,
	rows: ManualImportRow[],
	promptSetId: string | undefined,
): Promise<{ resolved: Map<number, ResolvedPrompt>; errors: ManualRowError[] }> {
	const errors: ManualRowError[] = [];
	const resolved = new Map<number, ResolvedPrompt>();
	const find = promptIndex(await promptCandidates(organizationId, promptSetId));
	const scope = promptSetId ? "所选问法集" : "问法库";
	for (const row of rows) {
		const matches = find(row);
		if (matches.length !== 1) {
			const message = matches.length === 0 ? `问题未在${scope}中找到` : `${scope}中有多条相同的问题，请填写问法 ID`;
			errors.push({ row: row.row, field: "question", code: "VALIDATION_ERROR", message });
			continue;
		}
		resolved.set(row.row, {
			promptId: matches[0].id,
			revision: matches[0].revision,
			questionText: row.question ?? matches[0].question,
			promptSetId: promptSetId ?? null,
		});
	}
	return { resolved, errors };
}

/** Manual evidence lands on an enabled MANUAL_EVIDENCE target of the row's platform. */
async function resolveTargets(
	organizationId: string,
	rows: ManualImportRow[],
): Promise<{ resolved: Map<number, typeof geoSamplingTargets.$inferSelect>; errors: ManualRowError[] }> {
	const targets = await db
		.select()
		.from(geoSamplingTargets)
		.where(
			and(eq(geoSamplingTargets.organizationId, organizationId), eq(geoSamplingTargets.surfaceMode, "MANUAL_EVIDENCE")),
		);
	const errors: ManualRowError[] = [];
	const resolved = new Map<number, (typeof targets)[number]>();
	for (const row of rows) {
		const candidates = targets.filter((target) =>
			row.targetId ? target.id === row.targetId : target.platform === row.platform && target.enabled,
		);
		const error = (message: string) =>
			errors.push({ row: row.row, field: "platform", code: "VALIDATION_ERROR", message });
		if (candidates.length === 0) error(row.targetId ? "指定的人工证据目标不存在" : "该平台没有已启用的人工证据目标");
		else if (candidates.length > 1) error("该平台有多个人工证据目标，请填写目标 ID");
		else if (candidates[0].platform !== row.platform) error("目标 ID 与平台不一致");
		else if (!candidates[0].enabled) error("指定的人工证据目标未启用");
		else resolved.set(row.row, candidates[0]);
	}
	return { resolved, errors };
}

/** An uploaded file is referenced as `upload:<sha256>.<ext>` and must already be in this organization's store. */
async function resolveEvidence(
	organizationId: string,
	rows: ManualImportRow[],
): Promise<{ resolved: Map<number, string>; errors: ManualRowError[] }> {
	const errors: ManualRowError[] = [];
	const resolved = new Map<number, string>();
	const store = getObjectStore();
	for (const row of rows) {
		if (!isUploadedEvidenceRef(row.evidenceLocation)) {
			resolved.set(row.row, row.evidenceLocation);
			continue;
		}
		const key = geoObjectKey(organizationId, "evidence", row.evidenceLocation.slice("upload:".length));
		if (await store.head(key)) resolved.set(row.row, key);
		else
			errors.push({
				row: row.row,
				field: "evidenceLocation",
				code: "EVIDENCE_REQUIRED",
				message: "引用的证据文件尚未上传",
			});
	}
	return { resolved, errors };
}

/**
 * All or nothing: a file with any bad row imports nothing and reports every problem by
 * row. Rows identical to evidence already imported are skipped rather than counted twice.
 */
export async function importManualObservations(
	principal: GeoPrincipal,
	input: ManualImportInput,
): Promise<ManualImportResult> {
	assertGeoPermission(principal, "evidence.import");
	if (input.promptSetId) {
		const [set] = await db
			.select({ id: geoPromptSets.id })
			.from(geoPromptSets)
			.where(and(eq(geoPromptSets.id, input.promptSetId), eq(geoPromptSets.organizationId, principal.organizationId)));
		if (!set) throw new GeoError("NOT_FOUND", "问法集不存在");
	}
	const parsed = parseContent(input);
	if ("error" in parsed) return rejected([parsed.error]);
	const validated = validateManualRows(parsed.rows);
	if (validated.errors.length) return rejected(validated.errors);

	const [prompts, targets, evidence] = await Promise.all([
		resolvePrompts(principal.organizationId, validated.rows, input.promptSetId),
		resolveTargets(principal.organizationId, validated.rows),
		resolveEvidence(principal.organizationId, validated.rows),
	]);
	const lookupErrors = [...prompts.errors, ...targets.errors, ...evidence.errors].sort((a, b) => a.row - b.row);
	if (lookupErrors.length) return rejected(lookupErrors);

	const importBatchId = randomUUID();
	const prepared = validated.rows.map((row) => {
		const prompt = prompts.resolved.get(row.row) as ResolvedPrompt;
		const target = targets.resolved.get(row.row) as typeof geoSamplingTargets.$inferSelect;
		const fingerprint = manualImportFingerprint({
			organizationId: principal.organizationId,
			targetId: target.id,
			promptId: prompt.promptId,
			sampledAt: row.sampledAt,
			responseText: row.responseText,
		});
		return { row, prompt, target, fingerprint, evidenceUri: evidence.resolved.get(row.row) as string };
	});

	const result = await db.transaction(async (tx) => {
		const fingerprints = prepared.map((item) => item.fingerprint);
		const existing = await tx
			.select({ fingerprint: sql<string>`${geoObservations.responseMetadata}->>'importFingerprint'` })
			.from(geoObservations)
			.where(
				and(
					eq(geoObservations.organizationId, principal.organizationId),
					inArray(sql`${geoObservations.responseMetadata}->>'importFingerprint'`, fingerprints),
				),
			);
		const seen = new Set(existing.map((item) => item.fingerprint));
		const created: { id: string; status: ManualImportRow["status"] }[] = [];
		const skippedRows: number[] = [];
		for (const item of prepared) {
			if (seen.has(item.fingerprint)) {
				skippedRows.push(item.row.row);
				continue;
			}
			seen.add(item.fingerprint);
			const [observation] = await tx
				.insert(geoObservations)
				.values({
					organizationId: principal.organizationId,
					promptId: item.prompt.promptId,
					promptSetId: item.prompt.promptSetId,
					promptRevision: item.prompt.revision,
					questionText: item.prompt.questionText,
					targetId: item.target.id,
					platform: item.target.platform,
					surfaceMode: "MANUAL_EVIDENCE",
					status: item.row.status,
					responseText: item.row.responseText,
					sampledAt: item.row.sampledAt,
					responseMetadata: {
						importFingerprint: item.fingerprint,
						importFormat: input.format,
						importRow: item.row.row,
						evidenceLocation: item.row.evidenceLocation,
						note: item.row.note,
						proxyEvaluation: false,
					},
					providerVersion: "manual",
					modelVersion: item.row.modelVersion,
					sourceMethodVersion: MANUAL_SOURCE_METHOD_VERSION,
					evidenceUri: item.evidenceUri,
					importBatchId,
					importedBy: principal.actorId,
				})
				.returning({ id: geoObservations.id });
			created.push({ id: observation.id, status: item.row.status });
			if (item.row.citations.length) {
				await tx.insert(geoObservationCitations).values(
					item.row.citations.map((citation, ordinal) => ({
						organizationId: principal.organizationId,
						observationId: observation.id,
						ordinal,
						url: citation.url,
						normalizedUrl: normalizeUrl(citation.url),
						host: hostOf(citation.url),
						title: citation.title ?? null,
					})),
				);
			}
		}
		await writeGeoAudit(tx, {
			principal,
			action: "observation.import",
			entityType: "observation_import",
			entityId: importBatchId,
			metadata: {
				format: input.format,
				created: created.length,
				skipped: skippedRows.length,
				promptSetId: input.promptSetId ?? null,
			},
		});
		return { created, skippedRows };
	});

	for (const { id: observationId, status } of result.created) {
		if (!isEvaluableObservation(status)) continue;
		try {
			await enqueueGeoJob(
				GEO_EVALUATE_OBSERVATION_QUEUE,
				{ organizationId: principal.organizationId, observationId },
				{ singletonKey: `observation:${observationId}` },
			);
		} catch (error) {
			console.warn(
				`[geo-sampling] evaluation not queued for imported observation ${observationId}: ${error instanceof Error ? error.name : "error"}`,
			);
		}
	}
	return {
		ok: true,
		importBatchId,
		created: result.created.length,
		skipped: result.skippedRows.length,
		observationIds: result.created.map((item) => item.id),
		skippedRows: result.skippedRows,
	};
}

export const EVIDENCE_MAX_BYTES = 10 * 1024 * 1024;

const SIGNATURES: { mime: string; ext: string; matches: (bytes: Uint8Array) => boolean }[] = [
	{ mime: "image/png", ext: "png", matches: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
	{ mime: "image/jpeg", ext: "jpg", matches: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
	{
		mime: "image/webp",
		ext: "webp",
		matches: (b) =>
			String.fromCharCode(...b.slice(0, 4)) === "RIFF" && String.fromCharCode(...b.slice(8, 12)) === "WEBP",
	},
	{ mime: "application/pdf", ext: "pdf", matches: (b) => String.fromCharCode(...b.slice(0, 5)) === "%PDF-" },
];

/** What the bytes are, not what the upload claims: screenshots and PDFs only. */
export function sniffEvidenceType(bytes: Uint8Array): { mime: string; ext: string } | null {
	const match = SIGNATURES.find((signature) => signature.matches(bytes));
	return match ? { mime: match.mime, ext: match.ext } : null;
}

export interface UploadedEvidence {
	ref: string;
	sha256: string;
	size: number;
	contentType: string;
}

/** Stored under its content hash, so the key never carries a user-supplied name and a repeat upload is the same object. */
export async function uploadEvidenceFile(principal: GeoPrincipal, file: File): Promise<UploadedEvidence> {
	assertGeoPermission(principal, "evidence.import");
	if (file.size === 0) throw new GeoError("VALIDATION_ERROR", "文件为空");
	if (file.size > EVIDENCE_MAX_BYTES) throw new GeoError("VALIDATION_ERROR", "证据文件不能超过 10 MB");
	const bytes = new Uint8Array(await file.arrayBuffer());
	const type = sniffEvidenceType(bytes);
	if (!type) throw new GeoError("VALIDATION_ERROR", "只支持 PNG、JPEG、WebP 截图或 PDF 文件");
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	const name = `${sha256}.${type.ext}`;
	await getObjectStore().put(geoObjectKey(principal.organizationId, "evidence", name), bytes, {
		contentType: type.mime,
	});
	await db.transaction((tx) =>
		writeGeoAudit(tx, {
			principal,
			action: "evidence.upload",
			entityType: "evidence_file",
			entityId: sha256,
			metadata: { size: bytes.length, contentType: type.mime },
		}),
	);
	return { ref: `upload:${name}`, sha256, size: bytes.length, contentType: type.mime };
}
