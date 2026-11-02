import { GEO_QUEUE, geoSystemPrincipal } from "@workspace/geo-domain";
import { geoObjectKey, getObjectStore } from "@workspace/geo-evidence";
import { previousChinaMonth, type ReportFilters, reportCsv } from "@workspace/geo-reports";
import { GeoPdfFontError, renderReportPdf, resolveCjkFont } from "@workspace/geo-reports/pdf";
import { assembleReportSnapshot, defaultPromptSet } from "@workspace/geo-reports/queries";
import { db } from "@workspace/lib/db/db";
import { geoGeneratedReports, geoObservations } from "@workspace/lib/db/schema";
import { writeGeoAudit } from "@workspace/lib/geo/audit";
import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { getBoss } from "../../boss";

export interface ReportJobData {
	organizationId?: string;
	reportId?: string;
}

export type ReportOutcome = { status: "SUCCEEDED" | "FAILED" | "SKIPPED"; reason?: string };

async function markFailed(reportId: string, summary: string) {
	await db
		.update(geoGeneratedReports)
		.set({ status: "FAILED", errorSummary: summary.slice(0, 500) })
		.where(eq(geoGeneratedReports.id, reportId));
}

/**
 * Builds the snapshot, then the CSV and PDF from it, and stores all three. The font is
 * checked first: a report without a usable Chinese font fails outright instead of
 * producing a PDF full of empty boxes.
 */
export async function generateReport(organizationId: string, reportId: string): Promise<ReportOutcome> {
	const [claimed] = await db
		.update(geoGeneratedReports)
		.set({ status: "RUNNING", errorSummary: null })
		.where(
			and(
				eq(geoGeneratedReports.id, reportId),
				eq(geoGeneratedReports.organizationId, organizationId),
				inArray(geoGeneratedReports.status, ["QUEUED", "RUNNING", "FAILED"]),
			),
		)
		.returning();
	if (!claimed) return { status: "SKIPPED", reason: "not-pending" };

	let font: ReturnType<typeof resolveCjkFont>;
	try {
		font = resolveCjkFont();
	} catch (error) {
		await markFailed(reportId, error instanceof Error ? error.message : "缺少中文字体");
		return { status: "FAILED", reason: "font" };
	}

	try {
		const filters = claimed.filters as ReportFilters;
		const snapshot = await assembleReportSnapshot(db, {
			organizationId,
			title: claimed.title,
			periodStart: claimed.periodStart,
			periodEnd: claimed.periodEnd,
			periodLabel: filters.periodLabel,
			promptSetId: filters.promptSetId,
			notes: filters.notes,
			nextPlan: filters.nextPlan,
		});
		const pdf = await renderReportPdf(snapshot, font, { baseUrl: process.env.APP_URL });
		const store = getObjectStore();
		const pdfKey = geoObjectKey(organizationId, "reports", reportId, "report.pdf");
		const csvKey = geoObjectKey(organizationId, "reports", reportId, "report.csv");
		await store.put(pdfKey, pdf, { contentType: "application/pdf" });
		await store.put(csvKey, reportCsv(snapshot), { contentType: "text/csv; charset=utf-8" });
		await db.transaction(async (tx) => {
			await tx
				.update(geoGeneratedReports)
				.set({
					status: "SUCCEEDED",
					snapshot,
					metricVersion: snapshot.metricVersion,
					pdfObjectKey: pdfKey,
					csvObjectKey: csvKey,
					errorSummary: null,
				})
				.where(eq(geoGeneratedReports.id, reportId));
			await writeGeoAudit(tx, {
				principal: geoSystemPrincipal(organizationId, "reports", `report:${reportId}`),
				action: "report.generated",
				entityType: "report",
				entityId: reportId,
				after: { metricVersion: snapshot.metricVersion, evaluations: snapshot.evaluationRefs.length },
			});
		});
		return { status: "SUCCEEDED" };
	} catch (error) {
		if (error instanceof GeoPdfFontError) {
			await markFailed(reportId, error.message);
			return { status: "FAILED", reason: "font" };
		}
		await markFailed(reportId, "报告生成失败，请稍后重试或联系管理员");
		throw error;
	}
}

/** The monthly report is created once the month is two hours over, for every organization that sampled in it. */
const MONTH_GRACE_MS = 2 * 3_600_000;
/** A queued report with no job after this long lost it. */
const QUEUED_STALE_MS = 5 * 60_000;
/** A report still running after this long belongs to a worker that died. */
const RUNNING_STALE_MS = 30 * 60_000;

async function createMonthlyReports(now: Date): Promise<number> {
	const period = previousChinaMonth(now);
	if (now.getTime() < period.end.getTime() + MONTH_GRACE_MS) return 0;
	const organizations = await db
		.selectDistinct({ organizationId: geoObservations.organizationId })
		.from(geoObservations)
		.where(and(gte(geoObservations.sampledAt, period.start), lt(geoObservations.sampledAt, period.end)));
	let created = 0;
	for (const { organizationId } of organizations) {
		const promptSet = await defaultPromptSet(db, organizationId, { from: period.start, to: period.end });
		const filters: ReportFilters = {
			kind: "MONTHLY",
			periodLabel: period.label,
			promptSetId: promptSet?.id ?? null,
			notes: null,
			nextPlan: null,
		};
		const reportId = await db.transaction(async (tx) => {
			await tx.execute(
				sql`select pg_advisory_xact_lock(hashtextextended(${`geo-monthly-report:${organizationId}`}, 0))`,
			);
			const [existing] = await tx
				.select({ id: geoGeneratedReports.id })
				.from(geoGeneratedReports)
				.where(
					and(
						eq(geoGeneratedReports.organizationId, organizationId),
						eq(geoGeneratedReports.periodStart, period.start),
						eq(geoGeneratedReports.periodEnd, period.end),
						sql`${geoGeneratedReports.filters}->>'kind' = 'MONTHLY'`,
					),
				)
				.limit(1);
			if (existing) return null;
			const [row] = await tx
				.insert(geoGeneratedReports)
				.values({
					organizationId,
					periodStart: period.start,
					periodEnd: period.end,
					metricVersion: "pending",
					filters,
					title: `GEO 月报 · ${period.label}`,
					generatedBy: "system:monthly-report",
				})
				.returning({ id: geoGeneratedReports.id });
			return row?.id ?? null;
		});
		if (reportId) {
			await sendReportJob(organizationId, reportId);
			created++;
		}
	}
	return created;
}

export async function sendReportJob(organizationId: string, reportId: string): Promise<void> {
	await getBoss().send(GEO_QUEUE.reportGenerate, { organizationId, reportId }, { singletonKey: `report:${reportId}` });
}

async function requeueStalled(now: Date): Promise<number> {
	const stalled = await db
		.select({ id: geoGeneratedReports.id, organizationId: geoGeneratedReports.organizationId })
		.from(geoGeneratedReports)
		.where(
			sql`(${geoGeneratedReports.status} = 'QUEUED' and ${geoGeneratedReports.updatedAt} < ${new Date(now.getTime() - QUEUED_STALE_MS)})
				or (${geoGeneratedReports.status} = 'RUNNING' and ${geoGeneratedReports.updatedAt} < ${new Date(now.getTime() - RUNNING_STALE_MS)})`,
		)
		.limit(100);
	for (const report of stalled) {
		await db.update(geoGeneratedReports).set({ status: "QUEUED" }).where(eq(geoGeneratedReports.id, report.id));
		await sendReportJob(report.organizationId, report.id);
	}
	return stalled.length;
}

export async function reportTick(now = new Date()): Promise<{ created: number; requeued: number }> {
	const created = await createMonthlyReports(now);
	const requeued = await requeueStalled(now);
	return { created, requeued };
}
