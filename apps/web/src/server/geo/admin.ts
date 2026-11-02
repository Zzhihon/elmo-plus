import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
	adminRequestInputSchema,
	alertActionSchema,
	auditQuerySchema,
	changeRole,
	createAdminRequest,
	decideRequest,
	decideRequestSchema,
	getOpsMetrics,
	getSettings,
	listAdminRequests,
	listAlerts,
	listAuditLogs,
	listCredentials,
	listMembers,
	operationalSettingsSchema,
	previewRetention,
	putCredential,
	putCredentialSchema,
	reencryptCredentials,
	removeCredential,
	requireAdminMfaPolicy,
	retentionSettingsSchema,
	revokeLlmUse,
	roleChangeSchema,
	securityStatus,
	setAlertStatus,
	updateOperationalSettings,
} from "./admin-core";
import { requireGeoServerFnPrincipal, resolveGeoSessionPrincipal } from "./context";

const orgOnly = z.object({ organizationId: z.string() });

/** What the settings page needs before it can decide which tabs to show. */
export const getGeoSecurityFn = createServerFn({ method: "GET" })
	.validator(orgOnly)
	.handler(async ({ data }) => securityStatus(await resolveGeoSessionPrincipal(data.organizationId)));

export const getGeoSettingsFn = createServerFn({ method: "GET" })
	.validator(orgOnly)
	.handler(async ({ data }) => getSettings(await requireGeoServerFnPrincipal(data.organizationId, "settings.read")));

export const updateGeoOperationalSettingsFn = createServerFn({ method: "POST" })
	.validator(orgOnly.extend({ input: operationalSettingsSchema }))
	.handler(async ({ data }) =>
		updateOperationalSettings(await requireGeoServerFnPrincipal(data.organizationId, "settings.manage"), data.input),
	);

export const revokeGeoLlmUseFn = createServerFn({ method: "POST" })
	.validator(orgOnly)
	.handler(async ({ data }) => revokeLlmUse(await requireGeoServerFnPrincipal(data.organizationId, "llm.approve")));

export const requireGeoAdminMfaFn = createServerFn({ method: "POST" })
	.validator(orgOnly)
	.handler(async ({ data }) => requireAdminMfaPolicy(await requireGeoServerFnPrincipal(data.organizationId, "settings.manage")));

export const listGeoAdminRequestsFn = createServerFn({ method: "GET" })
	.validator(orgOnly)
	.handler(async ({ data }) => listAdminRequests(await requireGeoServerFnPrincipal(data.organizationId, "settings.read")));

export const createGeoAdminRequestFn = createServerFn({ method: "POST" })
	.validator(orgOnly.extend({ input: adminRequestInputSchema }))
	.handler(async ({ data }) => {
		const request = await createAdminRequest(await requireGeoServerFnPrincipal(data.organizationId, "settings.read"), data.input);
		return { id: request.id };
	});

export const decideGeoAdminRequestFn = createServerFn({ method: "POST" })
	.validator(orgOnly.extend({ input: decideRequestSchema }))
	.handler(async ({ data }) => {
		const request = await decideRequest(await requireGeoServerFnPrincipal(data.organizationId, "settings.read"), data.input);
		return { id: request.id, status: request.status };
	});

export const previewGeoRetentionFn = createServerFn({ method: "POST" })
	.validator(orgOnly.extend({ retention: retentionSettingsSchema }))
	.handler(async ({ data }) => previewRetention(await requireGeoServerFnPrincipal(data.organizationId, "settings.read"), data.retention));

export const listGeoMembersFn = createServerFn({ method: "GET" })
	.validator(orgOnly)
	.handler(async ({ data }) => listMembers(await requireGeoServerFnPrincipal(data.organizationId, "settings.read")));

export const changeGeoRoleFn = createServerFn({ method: "POST" })
	.validator(orgOnly.extend({ input: roleChangeSchema }))
	.handler(async ({ data }) => changeRole(await requireGeoServerFnPrincipal(data.organizationId, "rbac.manage"), data.input));

export const listGeoCredentialsFn = createServerFn({ method: "GET" })
	.validator(orgOnly)
	.handler(async ({ data }) => listCredentials(await requireGeoServerFnPrincipal(data.organizationId, "secret.manage")));

export const putGeoCredentialFn = createServerFn({ method: "POST" })
	.validator(orgOnly.extend({ input: putCredentialSchema }))
	.handler(async ({ data }) => putCredential(await requireGeoServerFnPrincipal(data.organizationId, "secret.manage"), data.input));

export const removeGeoCredentialFn = createServerFn({ method: "POST" })
	.validator(orgOnly.extend({ ref: z.string().max(64) }))
	.handler(async ({ data }) => removeCredential(await requireGeoServerFnPrincipal(data.organizationId, "secret.manage"), data.ref));

export const reencryptGeoCredentialsFn = createServerFn({ method: "POST" })
	.validator(orgOnly)
	.handler(async ({ data }) => reencryptCredentials(await requireGeoServerFnPrincipal(data.organizationId, "secret.manage")));

export const listGeoAuditLogsFn = createServerFn({ method: "GET" })
	.validator(
		orgOnly.extend({
			filters: auditQuerySchema,
			page: z.number().int().min(1).default(1),
			limit: z.number().int().min(1).max(100).default(50),
		}),
	)
	.handler(async ({ data }) => {
		const principal = await requireGeoServerFnPrincipal(data.organizationId, "audit.read");
		const { rows, total } = await listAuditLogs(principal, data.filters, {
			limit: data.limit,
			offset: (data.page - 1) * data.limit,
		});
		return { rows, total, page: data.page, totalPages: Math.max(1, Math.ceil(total / data.limit)) };
	});

export const getGeoOpsMetricsFn = createServerFn({ method: "GET" })
	.validator(orgOnly)
	.handler(async ({ data }) => getOpsMetrics(await requireGeoServerFnPrincipal(data.organizationId, "settings.read")));

export const listGeoAlertsFn = createServerFn({ method: "GET" })
	.validator(orgOnly.extend({ includeResolved: z.boolean().default(false) }))
	.handler(async ({ data }) =>
		listAlerts(await requireGeoServerFnPrincipal(data.organizationId, "alert.read"), data.includeResolved),
	);

export const setGeoAlertStatusFn = createServerFn({ method: "POST" })
	.validator(orgOnly.extend({ input: alertActionSchema }))
	.handler(async ({ data }) =>
		setAlertStatus(await requireGeoServerFnPrincipal(data.organizationId, "alert.manage"), data.input),
	);
