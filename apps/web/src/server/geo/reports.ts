import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireGeoServerFnPrincipal } from "./context";
import {
	createReport,
	createReportInputSchema,
	getReport,
	listReports,
	reportReviewInputSchema,
	retryReport,
	reviewReport,
} from "./reports-core";

const org = z.object({ organizationId: z.string() });

export const listReportsFn = createServerFn({ method: "GET" })
	.validator(
		org.extend({ page: z.number().int().min(1).default(1), limit: z.number().int().min(1).max(100).default(20) }),
	)
	.handler(async ({ data }) => {
		const principal = await requireGeoServerFnPrincipal(data.organizationId, "report.read");
		const paging = { page: data.page, limit: data.limit, offset: (data.page - 1) * data.limit };
		const { rows, total } = await listReports(principal, paging);
		return { rows, total, page: data.page, totalPages: Math.ceil(total / data.limit) };
	});

export const getReportFn = createServerFn({ method: "GET" })
	.validator(org.extend({ reportId: z.guid() }))
	.handler(async ({ data }) => {
		const principal = await requireGeoServerFnPrincipal(data.organizationId, "report.read");
		return getReport(principal, data.reportId);
	});

export const createReportFn = createServerFn({ method: "POST" })
	.validator(org.extend({ input: createReportInputSchema }))
	.handler(async ({ data }) => {
		const principal = await requireGeoServerFnPrincipal(data.organizationId, "report.generate");
		return createReport(principal, data.input);
	});

export const retryReportFn = createServerFn({ method: "POST" })
	.validator(org.extend({ reportId: z.guid() }))
	.handler(async ({ data }) => {
		const principal = await requireGeoServerFnPrincipal(data.organizationId, "report.generate");
		return retryReport(principal, data.reportId);
	});

export const reviewReportFn = createServerFn({ method: "POST" })
	.validator(org.extend({ reportId: z.guid(), input: reportReviewInputSchema }))
	.handler(async ({ data }) => {
		const principal = await requireGeoServerFnPrincipal(data.organizationId, "report.review");
		return reviewReport(principal, data.reportId, data.input);
	});
