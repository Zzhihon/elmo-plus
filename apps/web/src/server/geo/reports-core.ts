import {
	assertGeoPermission,
	GEO_QUEUE,
	GeoError,
	type GeoPrincipal,
	type GeoReportReviewStatus,
	type GeoReportStatus,
} from "@workspace/geo-domain";
import { getObjectStore } from "@workspace/geo-evidence";
import {
	chinaDayRange,
	chinaMonth,
	type ReportFilters,
	type ReportSnapshot,
	unattributedClaimProblem,
} from "@workspace/geo-reports";
import { promptSetRef } from "@workspace/geo-reports/queries";
import { db } from "@workspace/lib/db/db";
import { geoAuditLogs, geoGeneratedReports } from "@workspace/lib/db/schema";
import { writeGeoAudit } from "@workspace/lib/geo/audit";
import { and, count, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { enqueueGeoJob } from "@/lib/geo/enqueue";

type Paging = { page: number; limit: number; offset: number };
type ReportRow = typeof geoGeneratedReports.$inferSelect;

const MAX_PERIOD_DAYS = 92;

const narrative = z
	.string()
	.trim()
	.max(2000)
	.refine((value) => unattributedClaimProblem(value) === null, {
		message: "报告中不能出现未经归因的订单或销售结果表述",
	});

export const createReportInputSchema = z
	.object({
		/** A calendar month (China time) as YYYY-MM, or an explicit day range. */
		month: z
			.string()
			.regex(/^\d{4}-(0[1-9]|1[0-2])$/, "月份格式应为 YYYY-MM")
			.optional(),
		from: z.iso.date().optional(),
		to: z.iso.date().optional(),
		promptSetId: z.guid().nullable().optional(),
		notes: narrative.optional(),
		nextPlan: z.array(narrative).max(10).optional(),
	})
	.refine((input) => Boolean(input.month) !== Boolean(input.from && input.to), {
		message: "请指定月份，或同时指定开始与结束日期",
	});
export type CreateReportInput = z.infer<typeof createReportInputSchema>;

export interface ReportSummary {
	id: string;
	title: string;
	periodStart: string;
	periodEnd: string;
	periodLabel: string;
	kind: ReportFilters["kind"];
	status: GeoReportStatus;
	reviewStatus: GeoReportReviewStatus;
	metricVersion: string;
	errorSummary: string | null;
	generatedBy: string;
	reviewedBy: string | null;
	reviewedAt: string | null;
	createdAt: string;
	hasPdf: boolean;
	hasCsv: boolean;
}

function summarize(row: ReportRow): ReportSummary {
	const filters = row.filters as ReportFilters;
	return {
		id: row.id,
		title: row.title,
		periodStart: row.periodStart.toISOString(),
		periodEnd: row.periodEnd.toISOString(),
		periodLabel: filters.periodLabel,
		kind: filters.kind,
		status: row.status,
		reviewStatus: row.reviewStatus,
		metricVersion: row.metricVersion,
		errorSummary: row.errorSummary,
		generatedBy: row.generatedBy,
		reviewedBy: row.reviewedBy,
		reviewedAt: row.reviewedAt?.toISOString() ?? null,
		createdAt: row.createdAt.toISOString(),
		hasPdf: row.pdfObjectKey !== null,
		hasCsv: row.csvObjectKey !== null,
	};
}

export async function listReports(principal: GeoPrincipal, paging: Paging) {
	assertGeoPermission(principal, "report.read");
	const where = eq(geoGeneratedReports.organizationId, principal.organizationId);
	const [rows, [total]] = await Promise.all([
		db
			.select()
			.from(geoGeneratedReports)
			.where(where)
			.orderBy(desc(geoGeneratedReports.periodStart), desc(geoGeneratedReports.createdAt))
			.limit(paging.limit)
			.offset(paging.offset),
		db.select({ value: count() }).from(geoGeneratedReports).where(where),
	]);
	return { rows: rows.map(summarize), total: total?.value ?? 0 };
}

async function loadReport(organizationId: string, reportId: string): Promise<ReportRow> {
	const [row] = await db
		.select()
		.from(geoGeneratedReports)
		.where(and(eq(geoGeneratedReports.id, reportId), eq(geoGeneratedReports.organizationId, organizationId)));
	if (!row) throw new GeoError("NOT_FOUND", "报告不存在");
	return row;
}

export interface ReportExportRecord {
	actorId: string;
	format: string;
	at: string;
}

export interface ReportDetail extends ReportSummary {
	snapshot: ReportSnapshot | null;
	reviewNote: string | null;
	notes: string | null;
	exports: ReportExportRecord[];
}

/** The stored snapshot as generated, plus who downloaded it and when. */
export async function getReport(principal: GeoPrincipal, reportId: string): Promise<ReportDetail> {
	assertGeoPermission(principal, "report.read");
	const row = await loadReport(principal.organizationId, reportId);
	const exports = await db
		.select({ actorId: geoAuditLogs.actorId, metadata: geoAuditLogs.metadata, createdAt: geoAuditLogs.createdAt })
		.from(geoAuditLogs)
		.where(
			and(
				eq(geoAuditLogs.organizationId, principal.organizationId),
				eq(geoAuditLogs.entityType, "report"),
				eq(geoAuditLogs.entityId, reportId),
				eq(geoAuditLogs.action, "report.export"),
			),
		)
		.orderBy(desc(geoAuditLogs.createdAt))
		.limit(100);
	const filters = row.filters as ReportFilters;
	return {
		...summarize(row),
		snapshot: (row.snapshot as ReportSnapshot | null) ?? null,
		reviewNote: row.reviewNote,
		notes: filters.notes,
		exports: exports.map((entry) => ({
			actorId: entry.actorId,
			format: String((entry.metadata as { format?: unknown } | null)?.format ?? ""),
			at: entry.createdAt.toISOString(),
		})),
	};
}

function periodOf(input: CreateReportInput) {
	if (input.month) {
		const [year, month] = input.month.split("-").map(Number);
		return chinaMonth(year ?? 0, month ?? 0);
	}
	const from = input.from ?? "";
	const to = input.to ?? "";
	if (from > to) throw new GeoError("VALIDATION_ERROR", "开始日期不能晚于结束日期");
	const period = chinaDayRange(from, to);
	if (period.end.getTime() - period.start.getTime() > MAX_PERIOD_DAYS * 86_400_000) {
		throw new GeoError("VALIDATION_ERROR", `报告周期最长 ${MAX_PERIOD_DAYS} 天`);
	}
	return period;
}

async function requestGeneration(organizationId: string, reportId: string): Promise<string | null> {
	try {
		return await enqueueGeoJob(
			GEO_QUEUE.reportGenerate,
			{ organizationId, reportId },
			{ singletonKey: `report:${reportId}` },
		);
	} catch (error) {
		// The report row is committed; the worker's tick re-queues a report whose job never arrived.
		console.warn(`[geo-reports] report ${reportId} not queued: ${error instanceof Error ? error.message : "error"}`);
		return null;
	}
}

/** Queues a report; the worker builds the snapshot and its files. */
export async function createReport(principal: GeoPrincipal, input: CreateReportInput) {
	assertGeoPermission(principal, "report.generate");
	const period = periodOf(input);
	if (period.start.getTime() > Date.now()) throw new GeoError("VALIDATION_ERROR", "报告周期尚未开始");
	if (input.promptSetId && !(await promptSetRef(db, principal.organizationId, input.promptSetId))) {
		throw new GeoError("NOT_FOUND", "问法集不存在");
	}
	const nextPlan = (input.nextPlan ?? []).filter((step) => step.length > 0);
	const filters: ReportFilters = {
		kind: input.month ? "MONTHLY" : "ADHOC",
		periodLabel: period.label,
		promptSetId: input.promptSetId ?? null,
		notes: input.notes || null,
		nextPlan: nextPlan.length > 0 ? nextPlan : null,
	};
	const row = await db.transaction(async (tx) => {
		const [created] = await tx
			.insert(geoGeneratedReports)
			.values({
				organizationId: principal.organizationId,
				periodStart: period.start,
				periodEnd: period.end,
				metricVersion: "pending",
				filters,
				title: `${input.month ? "GEO 月报" : "GEO 报告"} · ${period.label}`,
				generatedBy: principal.actorId,
			})
			.returning();
		if (!created) throw new Error("report insert returned nothing");
		await writeGeoAudit(tx, {
			principal,
			action: "report.generate",
			entityType: "report",
			entityId: created.id,
			after: { periodStart: created.periodStart, periodEnd: created.periodEnd, filters },
		});
		return created;
	});
	const jobId = await requestGeneration(principal.organizationId, row.id);
	return { report: summarize(row), jobId };
}

/** A failed report can be queued again; a successful one is never rebuilt, so it stays reproducible. */
export async function retryReport(principal: GeoPrincipal, reportId: string) {
	assertGeoPermission(principal, "report.generate");
	const row = await db.transaction(async (tx) => {
		const [updated] = await tx
			.update(geoGeneratedReports)
			.set({ status: "QUEUED", errorSummary: null })
			.where(
				and(
					eq(geoGeneratedReports.id, reportId),
					eq(geoGeneratedReports.organizationId, principal.organizationId),
					inArray(geoGeneratedReports.status, ["FAILED"]),
				),
			)
			.returning();
		if (!updated) throw new GeoError("CONFLICT", "只有生成失败的报告可以重新生成");
		await writeGeoAudit(tx, { principal, action: "report.retry", entityType: "report", entityId: reportId });
		return updated;
	});
	const jobId = await requestGeneration(principal.organizationId, row.id);
	return { report: summarize(row), jobId };
}

export const reportReviewInputSchema = z
	.object({
		decision: z.enum(["APPROVE", "REJECT"]),
		note: z.string().trim().max(2000).optional(),
	})
	.refine((input) => input.decision === "APPROVE" || (input.note?.length ?? 0) >= 2, {
		message: "驳回报告需要填写意见",
		path: ["note"],
	});

/** Someone other than whoever requested the report signs it off; the decision is audited. */
export async function reviewReport(
	principal: GeoPrincipal,
	reportId: string,
	input: z.infer<typeof reportReviewInputSchema>,
) {
	assertGeoPermission(principal, "report.review");
	return db.transaction(async (tx) => {
		const [row] = await tx
			.select()
			.from(geoGeneratedReports)
			.where(
				and(eq(geoGeneratedReports.id, reportId), eq(geoGeneratedReports.organizationId, principal.organizationId)),
			)
			.for("update");
		if (!row) throw new GeoError("NOT_FOUND", "报告不存在");
		if (row.status !== "SUCCEEDED") throw new GeoError("CONFLICT", "报告尚未生成成功，不能审核");
		if (row.generatedBy === principal.actorId) throw new GeoError("FORBIDDEN", "不能审核自己发起的报告");
		const reviewStatus: GeoReportReviewStatus = input.decision === "APPROVE" ? "APPROVED" : "REJECTED";
		const [updated] = await tx
			.update(geoGeneratedReports)
			.set({ reviewStatus, reviewNote: input.note || null, reviewedBy: principal.actorId, reviewedAt: new Date() })
			.where(eq(geoGeneratedReports.id, reportId))
			.returning();
		await writeGeoAudit(tx, {
			principal,
			action: input.decision === "APPROVE" ? "report.approve" : "report.reject",
			entityType: "report",
			entityId: reportId,
			before: { reviewStatus: row.reviewStatus },
			after: { reviewStatus },
		});
		if (!updated) throw new Error("report update returned nothing");
		return summarize(updated);
	});
}

export const reportFormatSchema = z.enum(["pdf", "csv"]);
export type ReportFormat = z.infer<typeof reportFormatSchema>;

/** Streams a stored export and records the download in the audit log (the export history). */
export async function exportReport(principal: GeoPrincipal, reportId: string, format: ReportFormat) {
	assertGeoPermission(principal, "report.read");
	const row = await loadReport(principal.organizationId, reportId);
	const key = format === "pdf" ? row.pdfObjectKey : row.csvObjectKey;
	if (row.status !== "SUCCEEDED" || !key) throw new GeoError("CONFLICT", "报告尚未生成成功，暂无可下载的文件");
	const object = await getObjectStore().get(key);
	if (!object) throw new GeoError("NOT_FOUND", "报告文件已不存在");
	await db.transaction((tx) =>
		writeGeoAudit(tx, {
			principal,
			action: "report.export",
			entityType: "report",
			entityId: reportId,
			metadata: { format },
		}),
	);
	const datePart = row.periodStart.toISOString().slice(0, 10);
	return {
		body: object.body,
		contentType: format === "pdf" ? "application/pdf" : "text/csv; charset=utf-8",
		filename: `geo-report-${datePart}-${reportId.slice(0, 8)}.${format}`,
	};
}

export function reportDownloadResponse(file: Awaited<ReturnType<typeof exportReport>>): Response {
	return new Response(new Uint8Array(file.body), {
		headers: {
			"Content-Type": file.contentType,
			"Content-Disposition": `attachment; filename="${file.filename}"`,
			"Cache-Control": "private, no-store",
			"X-Content-Type-Options": "nosniff",
		},
	});
}
