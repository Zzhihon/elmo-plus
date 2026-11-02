import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireGeoServerFnPrincipal } from "./context";
import {
	auditRunCreateSchema,
	createTasksFromFindings,
	findingFilterSchema,
	findingPatchSchema,
	findingTasksSchema,
	getSiteAuditFinding,
	getSiteAuditOverview,
	getSiteAuditRun,
	listAuditPromptChoices,
	listAuditSources,
	listSiteAuditFindingGroups,
	listSiteAuditRuns,
	startSiteAudit,
	updateSiteAuditFinding,
} from "./site-audit-core";

const org = z.object({ organizationId: z.string().min(1) });
const pagingSchema = z.object({
	page: z.number().int().min(1).default(1),
	limit: z.number().int().min(1).max(100).default(20),
});

function paging(input: { page: number; limit: number }) {
	return { page: input.page, limit: input.limit, offset: (input.page - 1) * input.limit };
}

export const listAuditSourcesFn = createServerFn({ method: "GET" })
	.validator(org)
	.handler(async ({ data }) =>
		listAuditSources(await requireGeoServerFnPrincipal(data.organizationId, "site_audit.read")),
	);

export const getSiteAuditOverviewFn = createServerFn({ method: "GET" })
	.validator(org.extend({ siteSourceId: z.string().uuid() }))
	.handler(async ({ data }) =>
		getSiteAuditOverview(await requireGeoServerFnPrincipal(data.organizationId, "site_audit.read"), data.siteSourceId),
	);

export const listSiteAuditFindingGroupsFn = createServerFn({ method: "GET" })
	.validator(org.extend({ filters: findingFilterSchema }).merge(pagingSchema))
	.handler(async ({ data }) =>
		listSiteAuditFindingGroups(
			await requireGeoServerFnPrincipal(data.organizationId, "site_audit.read"),
			data.filters,
			paging(data),
		),
	);

export const getSiteAuditFindingFn = createServerFn({ method: "GET" })
	.validator(org.extend({ findingId: z.string().uuid() }))
	.handler(async ({ data }) =>
		getSiteAuditFinding(await requireGeoServerFnPrincipal(data.organizationId, "site_audit.read"), data.findingId),
	);

export const updateSiteAuditFindingFn = createServerFn({ method: "POST" })
	.validator(org.extend({ findingId: z.string().uuid(), patch: findingPatchSchema }))
	.handler(async ({ data }) =>
		updateSiteAuditFinding(
			await requireGeoServerFnPrincipal(data.organizationId, "site_audit.triage"),
			data.findingId,
			data.patch,
		),
	);

export const createTasksFromFindingsFn = createServerFn({ method: "POST" })
	.validator(org.extend({ input: findingTasksSchema }))
	.handler(async ({ data }) =>
		createTasksFromFindings(await requireGeoServerFnPrincipal(data.organizationId, "task.create"), data.input),
	);

export const startSiteAuditFn = createServerFn({ method: "POST" })
	.validator(org.extend({ input: auditRunCreateSchema }))
	.handler(async ({ data }) =>
		startSiteAudit(await requireGeoServerFnPrincipal(data.organizationId, "site_audit.run"), data.input),
	);

export const listSiteAuditRunsFn = createServerFn({ method: "GET" })
	.validator(org.extend({ siteSourceId: z.string().uuid() }).merge(pagingSchema))
	.handler(async ({ data }) =>
		listSiteAuditRuns(
			await requireGeoServerFnPrincipal(data.organizationId, "site_audit.read"),
			{ siteSourceId: data.siteSourceId },
			paging(data),
		),
	);

export const getSiteAuditRunFn = createServerFn({ method: "GET" })
	.validator(org.extend({ runId: z.string().uuid() }))
	.handler(async ({ data }) =>
		getSiteAuditRun(await requireGeoServerFnPrincipal(data.organizationId, "site_audit.read"), data.runId),
	);

export const listAuditPromptChoicesFn = createServerFn({ method: "GET" })
	.validator(org)
	.handler(async ({ data }) =>
		listAuditPromptChoices(await requireGeoServerFnPrincipal(data.organizationId, "site_audit.read")),
	);
