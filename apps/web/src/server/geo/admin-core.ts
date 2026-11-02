import {
	adminRequestPermission,
	assertGeoPermission,
	assertGeoTransition,
	decideAdminRequest,
	GEO_ADMIN_REQUEST_TTL_HOURS,
	GEO_ALERT_STATUSES,
	GEO_RETENTION_MAXIMUM_DAYS,
	GEO_ROLES,
	type GeoAdminRequestKind,
	GeoError,
	type GeoPrincipal,
	type GeoRetentionSettings,
	type GeoRole,
	principalCan,
	retentionProblem,
	rolesForMember,
	transitionActorOf,
} from "@workspace/geo-domain";
import { db } from "@workspace/lib/db/db";
import type { DbConnection } from "@workspace/lib/db/db-connection";
import {
	account,
	geoAdminRequests,
	geoAlerts,
	geoAuditLogs,
	geoBackupRuns,
	geoOrgSettings,
	geoRoleAssignments,
	geoSamplingTargets,
	member,
	user,
} from "@workspace/lib/db/schema";
import { writeGeoAudit } from "@workspace/lib/geo/audit";
import {
	deleteGeoCredential,
	isGeoCredentialRef,
	listGeoCredentials,
	putGeoCredential,
	reencryptGeoCredentials,
} from "@workspace/lib/geo/credentials";
import { findGeoApprovalTimeouts, geoBackupHealth } from "@workspace/lib/geo/maintenance";
import { previewGeoRetention } from "@workspace/lib/geo/retention";
import { and, asc, count, desc, eq, gte, inArray, isNotNull, lte, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { getBoss } from "@/lib/boss-client";

type Settings = typeof geoOrgSettings.$inferSelect;

/** What a jsonb column holds, spelled out so server functions can serialize it. */
export type GeoJson = string | number | boolean | null | GeoJson[] | { [key: string]: GeoJson };
type GeoJsonObject = { [key: string]: GeoJson };

// ---------------------------------------------------------------------------
// Second factor for administrators
// ---------------------------------------------------------------------------

export interface GeoSecurityStatus {
	twoFactorEnabled: boolean;
	hasPassword: boolean;
	adminMfaRequired: boolean;
	/** Whether this person may use the admin settings as far as MFA goes. */
	mfaSatisfied: boolean;
}

async function settingsRow(tx: DbConnection, organizationId: string): Promise<Settings | null> {
	const [row] = await tx
		.select()
		.from(geoOrgSettings)
		.where(eq(geoOrgSettings.organizationId, organizationId))
		.limit(1);
	return row ?? null;
}

/**
 * A person signing in only through SSO has no password here for TOTP to sit beside;
 * their identity provider is expected to enforce the second factor.
 */
export async function securityStatus(principal: GeoPrincipal): Promise<GeoSecurityStatus> {
	const settings = await settingsRow(db, principal.organizationId);
	const adminMfaRequired = settings?.adminMfaRequired ?? true;
	if (principal.actorKind !== "user") {
		return { twoFactorEnabled: false, hasPassword: false, adminMfaRequired, mfaSatisfied: false };
	}
	const [row] = await db
		.select({ twoFactorEnabled: user.twoFactorEnabled })
		.from(user)
		.where(eq(user.id, principal.actorId))
		.limit(1);
	const [credential] = await db
		.select({ id: account.id })
		.from(account)
		.where(and(eq(account.userId, principal.actorId), eq(account.providerId, "credential")))
		.limit(1);
	const twoFactorEnabled = row?.twoFactorEnabled === true;
	const hasPassword = Boolean(credential);
	return {
		twoFactorEnabled,
		hasPassword,
		adminMfaRequired,
		mfaSatisfied: !adminMfaRequired || twoFactorEnabled || !hasPassword,
	};
}

export async function assertAdminMfa(principal: GeoPrincipal): Promise<void> {
	const status = await securityStatus(principal);
	if (!status.mfaSatisfied) {
		throw new GeoError("FORBIDDEN", "管理设置要求两步验证：请先在「安全」页启用两步验证");
	}
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface GeoSettingsView {
	llmUseApproved: boolean;
	llmApprovedBy: string | null;
	llmApprovedAt: string | null;
	samplingDailyLimit: number | null;
	samplingBatchLimit: number | null;
	samplingCostBudget: string | null;
	evidenceRetentionDays: number | null;
	snapshotRetentionDays: number | null;
	auditRetentionDays: number | null;
	alertRecipients: string[];
	adminMfaRequired: boolean;
	updatedAt: string | null;
	emailDelivery: boolean;
}

function view(row: Settings | null): GeoSettingsView {
	return {
		llmUseApproved: row?.llmUseApproved ?? false,
		llmApprovedBy: row?.approvedBy ?? null,
		llmApprovedAt: row?.approvedAt?.toISOString() ?? null,
		samplingDailyLimit: row?.samplingDailyLimit ?? null,
		samplingBatchLimit: row?.samplingBatchLimit ?? null,
		samplingCostBudget: row?.samplingCostBudget ?? null,
		evidenceRetentionDays: row?.evidenceRetentionDays ?? null,
		snapshotRetentionDays: row?.snapshotRetentionDays ?? null,
		auditRetentionDays: row?.auditRetentionDays ?? null,
		alertRecipients: row?.alertRecipients ?? [],
		adminMfaRequired: row?.adminMfaRequired ?? true,
		updatedAt: row?.updatedAt?.toISOString() ?? null,
		emailDelivery: Boolean(process.env.RESEND_API_KEY && process.env.RESEND_FROM_EMAIL),
	};
}

export async function getSettings(principal: GeoPrincipal): Promise<GeoSettingsView> {
	assertGeoPermission(principal, "settings.read");
	return view(await settingsRow(db, principal.organizationId));
}

async function writeSettings(
	tx: DbConnection,
	principal: GeoPrincipal,
	patch: Partial<typeof geoOrgSettings.$inferInsert>,
	action: string,
	metadata: Record<string, unknown>,
) {
	const before = await settingsRow(tx, principal.organizationId);
	const values = { ...patch, updatedBy: principal.actorId };
	const [after] = await tx
		.insert(geoOrgSettings)
		.values({ organizationId: principal.organizationId, ...values })
		.onConflictDoUpdate({ target: geoOrgSettings.organizationId, set: values })
		.returning();
	await writeGeoAudit(tx, {
		principal,
		action,
		entityType: "geo_org_settings",
		entityId: principal.organizationId,
		before,
		after,
		metadata,
	});
	return after;
}

const nullableCount = z.number().int().min(1).max(1_000_000).nullable();

export const operationalSettingsSchema = z.object({
	samplingDailyLimit: nullableCount,
	samplingBatchLimit: nullableCount,
	samplingCostBudget: z
		.string()
		.trim()
		.regex(/^\d{1,8}(\.\d{1,4})?$/, "预算必须是不超过 4 位小数的金额")
		.nullable(),
	alertRecipients: z.array(z.string().trim().email("告警接收人必须是邮箱地址")).max(20),
});

export async function updateOperationalSettings(
	principal: GeoPrincipal,
	input: z.infer<typeof operationalSettingsSchema>,
): Promise<GeoSettingsView> {
	assertGeoPermission(principal, "settings.manage");
	const recipients = [...new Set(input.alertRecipients.map((email) => email.toLowerCase()))];
	return db.transaction(async (tx) =>
		view(
			await writeSettings(
				tx,
				principal,
				{
					samplingDailyLimit: input.samplingDailyLimit,
					samplingBatchLimit: input.samplingBatchLimit,
					samplingCostBudget: input.samplingCostBudget,
					alertRecipients: recipients,
				},
				"settings.update",
				{ fields: ["samplingDailyLimit", "samplingBatchLimit", "samplingCostBudget", "alertRecipients"] },
			),
		),
	);
}

/** Withdrawing approval is the safe direction, so it takes one administrator and applies at once. */
export async function revokeLlmUse(principal: GeoPrincipal): Promise<GeoSettingsView> {
	assertGeoPermission(principal, "llm.approve");
	return db.transaction(async (tx) =>
		view(
			await writeSettings(
				tx,
				principal,
				{ llmUseApproved: false, approvedBy: null, approvedAt: null },
				"settings.llm_revoke",
				{},
			),
		),
	);
}

export async function requireAdminMfaPolicy(principal: GeoPrincipal): Promise<GeoSettingsView> {
	assertGeoPermission(principal, "settings.manage");
	return db.transaction(async (tx) =>
		view(await writeSettings(tx, principal, { adminMfaRequired: true }, "settings.mfa_require", {})),
	);
}

// ---------------------------------------------------------------------------
// Dual-control requests
// ---------------------------------------------------------------------------

const retentionDays = z.number().int().min(1).max(GEO_RETENTION_MAXIMUM_DAYS).nullable();

export const retentionSettingsSchema = z.object({
	evidenceRetentionDays: retentionDays,
	snapshotRetentionDays: retentionDays,
	auditRetentionDays: retentionDays,
});

export const adminRequestInputSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("LLM_USE_APPROVAL"), reason: z.string().trim().min(1).max(2000) }),
	z.object({
		kind: z.literal("RETENTION_CHANGE"),
		reason: z.string().trim().min(1).max(2000),
		retention: retentionSettingsSchema,
	}),
	z.object({ kind: z.literal("ADMIN_MFA_POLICY"), reason: z.string().trim().min(1).max(2000) }),
]);
export type AdminRequestInput = z.infer<typeof adminRequestInputSchema>;

function payloadOf(input: AdminRequestInput, current: GeoSettingsView): Record<string, unknown> {
	switch (input.kind) {
		case "LLM_USE_APPROVAL":
			if (current.llmUseApproved) throw new GeoError("CONFLICT", "LLM 调用已获批准");
			return { llmUseApproved: true };
		case "RETENTION_CHANGE": {
			const problem = retentionProblem(input.retention);
			if (problem) throw new GeoError("VALIDATION_ERROR", problem);
			return { retention: input.retention };
		}
		case "ADMIN_MFA_POLICY":
			if (!current.adminMfaRequired) throw new GeoError("CONFLICT", "管理员 MFA 要求已关闭");
			return { adminMfaRequired: false };
	}
}

export async function createAdminRequest(principal: GeoPrincipal, input: AdminRequestInput) {
	assertGeoPermission(principal, adminRequestPermission(input.kind));
	return db.transaction(async (tx) => {
		const payload = payloadOf(input, view(await settingsRow(tx, principal.organizationId)));
		const [request] = await tx
			.insert(geoAdminRequests)
			.values({
				organizationId: principal.organizationId,
				kind: input.kind,
				payload,
				reason: input.reason,
				requestedBy: principal.actorId,
				expiresAt: new Date(Date.now() + GEO_ADMIN_REQUEST_TTL_HOURS * 60 * 60 * 1000),
			})
			.onConflictDoNothing()
			.returning();
		if (!request) throw new GeoError("CONFLICT", "同类申请已在等待审批，请先处理该申请");
		await writeGeoAudit(tx, {
			principal,
			action: "admin_request.create",
			entityType: "geo_admin_request",
			entityId: request.id,
			after: request,
			metadata: { kind: input.kind },
		});
		return request;
	});
}

async function applyApproved(
	tx: DbConnection,
	principal: GeoPrincipal,
	kind: GeoAdminRequestKind,
	payload: Record<string, unknown>,
	requestId: string,
) {
	switch (kind) {
		case "LLM_USE_APPROVAL":
			await writeSettings(
				tx,
				principal,
				{ llmUseApproved: true, approvedBy: principal.actorId, approvedAt: new Date() },
				"settings.llm_approve",
				{ requestId },
			);
			return;
		case "RETENTION_CHANGE": {
			const retention = retentionSettingsSchema.parse(payload.retention) satisfies GeoRetentionSettings;
			await writeSettings(tx, principal, retention, "settings.retention_change", { requestId, ...retention });
			return;
		}
		case "ADMIN_MFA_POLICY":
			await writeSettings(tx, principal, { adminMfaRequired: false }, "settings.mfa_relax", { requestId });
			return;
	}
}

export const decideRequestSchema = z.object({
	requestId: z.string().uuid(),
	decision: z.enum(["APPROVE", "REJECT", "CANCEL"]),
	comment: z.string().trim().max(2000).nullish(),
});

export async function decideRequest(principal: GeoPrincipal, input: z.infer<typeof decideRequestSchema>) {
	return db.transaction(async (tx) => {
		const [request] = await tx
			.select()
			.from(geoAdminRequests)
			.where(
				and(eq(geoAdminRequests.organizationId, principal.organizationId), eq(geoAdminRequests.id, input.requestId)),
			)
			.for("update")
			.limit(1);
		if (!request) throw new GeoError("NOT_FOUND", "申请不存在");
		const status = assertGeoTransition(
			decideAdminRequest({
				request,
				decision: input.decision,
				actor: transitionActorOf(principal),
				comment: input.comment,
			}),
		);
		const [decided] = await tx
			.update(geoAdminRequests)
			.set({
				status,
				decidedBy: principal.actorId,
				decisionComment: input.comment ?? null,
				decidedAt: new Date(),
			})
			.where(eq(geoAdminRequests.id, request.id))
			.returning();
		await writeGeoAudit(tx, {
			principal,
			action: `admin_request.${input.decision.toLowerCase()}`,
			entityType: "geo_admin_request",
			entityId: request.id,
			before: request,
			after: decided,
			metadata: { kind: request.kind, requestedBy: request.requestedBy },
		});
		if (status === "APPROVED") {
			await applyApproved(tx, principal, request.kind, request.payload as Record<string, unknown>, request.id);
		}
		return decided;
	});
}

export async function listAdminRequests(principal: GeoPrincipal) {
	assertGeoPermission(principal, "settings.read");
	const rows = await db
		.select()
		.from(geoAdminRequests)
		.where(eq(geoAdminRequests.organizationId, principal.organizationId))
		.orderBy(desc(geoAdminRequests.createdAt))
		.limit(50);
	const names = await namesOf(rows.flatMap((row) => [row.requestedBy, ...(row.decidedBy ? [row.decidedBy] : [])]));
	return rows.map((row) => ({
		...row,
		payload: row.payload as GeoJsonObject,
		createdAt: row.createdAt.toISOString(),
		decidedAt: row.decidedAt?.toISOString() ?? null,
		expiresAt: row.expiresAt.toISOString(),
		requestedByName: names[row.requestedBy] ?? row.requestedBy,
		decidedByName: row.decidedBy ? (names[row.decidedBy] ?? row.decidedBy) : null,
	}));
}

export async function previewRetention(principal: GeoPrincipal, retention: GeoRetentionSettings) {
	assertGeoPermission(principal, "settings.read");
	const problem = retentionProblem(retention);
	if (problem) throw new GeoError("VALIDATION_ERROR", problem);
	return previewGeoRetention(db, principal.organizationId, retention);
}

// ---------------------------------------------------------------------------
// Members and roles
// ---------------------------------------------------------------------------

async function namesOf(ids: string[]): Promise<Record<string, string>> {
	const userIds = [...new Set(ids)].filter((id) => !id.includes(":") && id !== "instance-admin");
	if (userIds.length === 0) return {};
	const rows = await db.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, userIds));
	return Object.fromEntries(rows.map((row) => [row.id, row.name]));
}

export async function listMembers(principal: GeoPrincipal) {
	assertGeoPermission(principal, "settings.read");
	const members = await db
		.select({
			userId: user.id,
			name: user.name,
			email: user.email,
			memberRole: member.role,
			twoFactorEnabled: user.twoFactorEnabled,
		})
		.from(member)
		.innerJoin(user, eq(user.id, member.userId))
		.where(eq(member.organizationId, principal.organizationId))
		.orderBy(asc(user.name));
	const assignments = await db
		.select({ userId: geoRoleAssignments.userId, role: geoRoleAssignments.role })
		.from(geoRoleAssignments)
		.where(eq(geoRoleAssignments.organizationId, principal.organizationId));
	return members.map((row) => {
		const assigned = assignments.filter((a) => a.userId === row.userId).map((a) => a.role);
		return {
			...row,
			twoFactorEnabled: row.twoFactorEnabled === true,
			assigned,
			effective: rolesForMember(row.memberRole, assigned),
			implicitAdmin: row.memberRole.split(",").some((role) => ["owner", "admin"].includes(role.trim())),
		};
	});
}

const ASSIGNABLE_ROLES = GEO_ROLES.filter((role) => role !== "viewer") as [GeoRole, ...GeoRole[]];

export const roleChangeSchema = z.object({
	userId: z.string().min(1).max(200),
	role: z.enum(ASSIGNABLE_ROLES),
	grant: z.boolean(),
});

/** Every grant and revocation is audited, including an administrator granting themselves a reviewer role. */
export async function changeRole(principal: GeoPrincipal, input: z.infer<typeof roleChangeSchema>) {
	assertGeoPermission(principal, "rbac.manage");
	return db.transaction(async (tx) => {
		const [membership] = await tx
			.select({ id: member.id })
			.from(member)
			.where(and(eq(member.organizationId, principal.organizationId), eq(member.userId, input.userId)))
			.limit(1);
		if (!membership) throw new GeoError("NOT_FOUND", "成员不存在");

		const rows = input.grant
			? await tx
					.insert(geoRoleAssignments)
					.values({
						organizationId: principal.organizationId,
						userId: input.userId,
						role: input.role,
						grantedBy: principal.actorId,
					})
					.onConflictDoNothing()
					.returning()
			: await tx
					.delete(geoRoleAssignments)
					.where(
						and(
							eq(geoRoleAssignments.organizationId, principal.organizationId),
							eq(geoRoleAssignments.userId, input.userId),
							eq(geoRoleAssignments.role, input.role),
						),
					)
					.returning();
		if (rows.length === 0) return { changed: false };
		await writeGeoAudit(tx, {
			principal,
			action: input.grant ? "rbac.grant" : "rbac.revoke",
			entityType: "geo_role_assignment",
			entityId: `${input.userId}:${input.role}`,
			before: input.grant ? null : rows[0],
			after: input.grant ? rows[0] : null,
			metadata: { userId: input.userId, role: input.role, self: input.userId === principal.actorId },
		});
		return { changed: true };
	});
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

export async function listCredentials(principal: GeoPrincipal) {
	assertGeoPermission(principal, "secret.manage");
	const [credentials, targets] = await Promise.all([
		listGeoCredentials(db, principal.organizationId),
		db
			.select({ credentialRef: geoSamplingTargets.credentialRef, platform: geoSamplingTargets.platform })
			.from(geoSamplingTargets)
			.where(
				and(
					eq(geoSamplingTargets.organizationId, principal.organizationId),
					isNotNull(geoSamplingTargets.credentialRef),
				),
			),
	]);
	const configured = new Set(credentials.map((credential) => credential.ref));
	// A target's own credential, set on the target itself, is not one of these organization references.
	const referencing = targets.filter((target) => isGeoCredentialRef(target.credentialRef as string));
	return {
		credentials: credentials.map((credential) => ({
			ref: credential.ref,
			createdAt: credential.createdAt.toISOString(),
			updatedAt: credential.updatedAt.toISOString(),
			keyId: credential.keyId,
			needsReencryption: credential.needsReencryption,
			usedBy: referencing.filter((target) => target.credentialRef === credential.ref).map((target) => target.platform),
		})),
		missingRefs: [...new Set(referencing.map((target) => target.credentialRef as string))].filter(
			(ref) => !configured.has(ref),
		),
	};
}

export const putCredentialSchema = z.object({
	ref: z.string().trim().refine(isGeoCredentialRef, "引用名只能包含大写字母、数字和下划线"),
	value: z.string().min(1).max(8192),
});

/** Creating and rotating are the same write; the value is never returned or logged, only the reference. */
export async function putCredential(principal: GeoPrincipal, input: z.infer<typeof putCredentialSchema>) {
	assertGeoPermission(principal, "secret.manage");
	return db.transaction(async (tx) => {
		const { created } = await putGeoCredential(tx, principal.organizationId, input.ref, input.value);
		await writeGeoAudit(tx, {
			principal,
			action: created ? "secret.create" : "secret.rotate",
			entityType: "geo_credential",
			entityId: input.ref,
			metadata: { ref: input.ref },
		});
		return { ref: input.ref, created };
	});
}

export async function removeCredential(principal: GeoPrincipal, ref: string) {
	assertGeoPermission(principal, "secret.manage");
	return db.transaction(async (tx) => {
		const removed = await deleteGeoCredential(tx, principal.organizationId, ref);
		if (!removed) throw new GeoError("NOT_FOUND", "密钥不存在");
		await writeGeoAudit(tx, {
			principal,
			action: "secret.delete",
			entityType: "geo_credential",
			entityId: ref,
			metadata: { ref },
		});
		return { ref };
	});
}

export async function reencryptCredentials(principal: GeoPrincipal) {
	assertGeoPermission(principal, "secret.manage");
	return db.transaction(async (tx) => {
		const result = await reencryptGeoCredentials(tx, principal.organizationId);
		await writeGeoAudit(tx, {
			principal,
			action: "secret.reencrypt",
			entityType: "geo_credential",
			entityId: "*",
			metadata: result,
		});
		return result;
	});
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

export const auditQuerySchema = z.object({
	actorId: z.string().trim().max(200).optional(),
	action: z.string().trim().max(100).optional(),
	entityType: z.string().trim().max(100).optional(),
	entityId: z.string().trim().max(200).optional(),
	from: z.string().datetime({ offset: true }).optional(),
	to: z.string().datetime({ offset: true }).optional(),
});
export type AuditQuery = z.infer<typeof auditQuerySchema>;

export async function listAuditLogs(
	principal: GeoPrincipal,
	filters: AuditQuery,
	paging: { limit: number; offset: number },
) {
	assertGeoPermission(principal, "audit.read");
	const conditions = [eq(geoAuditLogs.organizationId, principal.organizationId)];
	if (filters.actorId) conditions.push(eq(geoAuditLogs.actorId, filters.actorId));
	if (filters.action) {
		// "task." matches every task action; a full name matches just that one.
		conditions.push(
			filters.action.endsWith(".")
				? sql`left(${geoAuditLogs.action}, ${filters.action.length}) = ${filters.action}`
				: eq(geoAuditLogs.action, filters.action),
		);
	}
	if (filters.entityType) conditions.push(eq(geoAuditLogs.entityType, filters.entityType));
	if (filters.entityId) conditions.push(eq(geoAuditLogs.entityId, filters.entityId));
	if (filters.from) conditions.push(gte(geoAuditLogs.createdAt, new Date(filters.from)));
	if (filters.to) conditions.push(lte(geoAuditLogs.createdAt, new Date(filters.to)));
	const where = and(...conditions);

	const [{ total }] = await db.select({ total: count() }).from(geoAuditLogs).where(where);
	const rows = await db
		.select()
		.from(geoAuditLogs)
		.where(where)
		.orderBy(desc(geoAuditLogs.createdAt), desc(geoAuditLogs.id))
		.limit(paging.limit)
		.offset(paging.offset);
	const names = await namesOf(rows.map((row) => row.actorId));
	return {
		rows: rows.map((row) => ({
			id: row.id,
			actorId: row.actorId,
			actorName: names[row.actorId] ?? null,
			actorKind: row.actorKind,
			action: row.action,
			entityType: row.entityType,
			entityId: row.entityId,
			beforeHash: row.beforeHash,
			afterHash: row.afterHash,
			metadata: (row.metadata ?? null) as GeoJsonObject | null,
			requestId: row.requestId,
			createdAt: row.createdAt.toISOString(),
		})),
		total,
	};
}

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

export async function listAlerts(principal: GeoPrincipal, includeResolved: boolean) {
	assertGeoPermission(principal, "alert.read");
	const rows = await db
		.select()
		.from(geoAlerts)
		.where(
			and(
				eq(geoAlerts.organizationId, principal.organizationId),
				includeResolved ? undefined : ne(geoAlerts.status, "RESOLVED"),
			),
		)
		.orderBy(desc(geoAlerts.lastSeen))
		.limit(100);
	return rows.map((row) => ({
		...row,
		context: row.context as GeoJsonObject,
		firstSeen: row.firstSeen.toISOString(),
		lastSeen: row.lastSeen.toISOString(),
		resolvedAt: row.resolvedAt?.toISOString() ?? null,
		notifiedAt: row.notifiedAt?.toISOString() ?? null,
	}));
}

export const alertActionSchema = z.object({
	alertId: z.string().uuid(),
	status: z.enum(GEO_ALERT_STATUSES).exclude(["OPEN"]),
});

export async function setAlertStatus(principal: GeoPrincipal, input: z.infer<typeof alertActionSchema>) {
	assertGeoPermission(principal, "alert.manage");
	return db.transaction(async (tx) => {
		const [before] = await tx
			.select()
			.from(geoAlerts)
			.where(and(eq(geoAlerts.organizationId, principal.organizationId), eq(geoAlerts.id, input.alertId)))
			.limit(1);
		if (!before) throw new GeoError("NOT_FOUND", "告警不存在");
		if (before.status === "RESOLVED") throw new GeoError("CONFLICT", "告警已关闭");
		const [after] = await tx
			.update(geoAlerts)
			.set({ status: input.status, resolvedAt: input.status === "RESOLVED" ? new Date() : null })
			.where(eq(geoAlerts.id, before.id))
			.returning();
		await writeGeoAudit(tx, {
			principal,
			action: input.status === "ACK" ? "alert.ack" : "alert.resolve",
			entityType: "geo_alert",
			entityId: before.id,
			before,
			after,
			metadata: { kind: before.kind },
		});
		return { id: after.id, status: after.status };
	});
}

// ---------------------------------------------------------------------------
// Operations dashboard (PRD 10.3)
// ---------------------------------------------------------------------------

const WINDOW_DAYS = 7;
const REPORT_WINDOW_DAYS = 30;

async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
	return (await db.execute(query)).rows as T[];
}

async function queueBacklog() {
	try {
		const boss = await getBoss();
		const queues = await boss.getQueues();
		return queues
			.filter((queue) => queue.name.startsWith("geo-"))
			.map((queue) => ({
				name: queue.name,
				queued: queue.queuedCount,
				active: queue.activeCount,
				failed: queue.failedCount,
				deferred: queue.deferredCount,
			}))
			.sort((a, b) => a.name.localeCompare(b.name));
	} catch {
		return null;
	}
}

/** Reads the tables each slice writes; one that holds nothing yet simply reports no data. */
export async function getOpsMetrics(principal: GeoPrincipal) {
	assertGeoPermission(principal, "settings.read");
	const organizationId = principal.organizationId;
	const since = sql`now() - make_interval(days => ${WINDOW_DAYS})`;

	const [runs, durations, retries, reviews, reports, timeouts, alertCounts, backups, health, queues] =
		await Promise.all([
			rows<{ status: string; count: string }>(sql`
			select status, count(*) as count from geo_sampling_runs
			where organization_id = ${organizationId} and created_at >= ${since}
			group by status`),
			rows<{ platform: string; samples: string; p50: number | null; p95: number | null; avg_cost: string | null }>(sql`
			select t.platform, count(*) as samples,
				percentile_cont(0.5) within group (order by a.duration_ms) as p50,
				percentile_cont(0.95) within group (order by a.duration_ms) as p95,
				avg(a.cost_estimate) as avg_cost
			from geo_sampling_attempts a
			join geo_sampling_runs r on r.id = a.run_id
			join geo_sampling_targets t on t.id = r.target_id
			where a.organization_id = ${organizationId} and a.started_at >= ${since} and a.duration_ms is not null
			group by t.platform order by t.platform`),
			rows<{ retried_attempts: string; resampled_runs: string }>(sql`
			select
				(select count(*) from geo_sampling_attempts where organization_id = ${organizationId}
					and started_at >= ${since} and attempt_no > 1) as retried_attempts,
				(select count(*) from geo_sampling_runs where organization_id = ${organizationId}
					and created_at >= ${since} and retry_of_run_id is not null) as resampled_runs`),
			rows<{ total: string; pending: string; reviewed: string }>(sql`
			select count(*) as total,
				count(*) filter (where review_status = 'PENDING_REVIEW') as pending,
				count(*) filter (where review_status in ('CONFIRMED', 'CORRECTED')) as reviewed
			from geo_evaluations where organization_id = ${organizationId} and is_current and created_at >= ${since}`),
			rows<{ status: string; count: string }>(sql`
			select status, count(*) as count from geo_generated_reports
			where organization_id = ${organizationId}
				and created_at >= now() - make_interval(days => ${REPORT_WINDOW_DAYS})
			group by status`),
			findGeoApprovalTimeouts(db, organizationId),
			db
				.select({ severity: geoAlerts.severity, count: count() })
				.from(geoAlerts)
				.where(and(eq(geoAlerts.organizationId, organizationId), ne(geoAlerts.status, "RESOLVED")))
				.groupBy(geoAlerts.severity),
			db.execute(sql`
			select distinct on (kind) kind, status, started_at, finished_at, database_bytes, object_count,
				offsite_copied, duration_seconds, location, message
			from ${geoBackupRuns} order by kind, finished_at desc`),
			geoBackupHealth(db),
			queueBacklog(),
		]);

	const runCounts = Object.fromEntries(runs.map((row) => [row.status, Number(row.count)]));
	const sum = (...statuses: string[]) => statuses.reduce((total, status) => total + (runCounts[status] ?? 0), 0);
	const reportCounts = Object.fromEntries(reports.map((row) => [row.status, Number(row.count)]));
	const review = reviews[0];

	return {
		windowDays: WINDOW_DAYS,
		sampling: {
			planned: Object.values(runCounts).reduce((a, b) => a + b, 0),
			valid: sum("VALID"),
			partial: sum("PARTIAL"),
			unavailable: sum("UNAVAILABLE", "NEEDS_MANUAL", "CAPTCHA"),
			failed: sum("FAILED", "TIMEOUT", "RATE_LIMITED"),
			inFlight: sum("PLANNED", "RUNNING"),
		},
		durations: durations.map((row) => ({
			platform: row.platform,
			samples: Number(row.samples),
			p50: row.p50 === null ? null : Math.round(Number(row.p50)),
			p95: row.p95 === null ? null : Math.round(Number(row.p95)),
			avgCost: row.avg_cost === null ? null : Number(row.avg_cost),
		})),
		retries: {
			retriedAttempts: Number(retries[0]?.retried_attempts ?? 0),
			resampledRuns: Number(retries[0]?.resampled_runs ?? 0),
		},
		review: {
			total: Number(review?.total ?? 0),
			pending: Number(review?.pending ?? 0),
			reviewed: Number(review?.reviewed ?? 0),
		},
		reports: {
			windowDays: REPORT_WINDOW_DAYS,
			succeeded: reportCounts.SUCCEEDED ?? 0,
			failed: reportCounts.FAILED ?? 0,
			pending: (reportCounts.QUEUED ?? 0) + (reportCounts.RUNNING ?? 0),
		},
		approvals: {
			overdueTasks: timeouts.tasks.map((task) => ({ ...task, enteredAt: task.enteredAt.toISOString() })),
			overdueRequests: timeouts.requests.map((request) => ({ ...request, createdAt: request.createdAt.toISOString() })),
		},
		openAlerts: Object.fromEntries(alertCounts.map((row) => [row.severity, row.count])) as Record<string, number>,
		backups: {
			health: { state: health.state, lastSuccessAt: health.lastSuccessAt?.toISOString() ?? null },
			latest: (backups.rows as Record<string, unknown>[]).map((row) => ({
				kind: String(row.kind),
				status: String(row.status),
				startedAt: new Date(row.started_at as string).toISOString(),
				finishedAt: new Date(row.finished_at as string).toISOString(),
				databaseBytes: row.database_bytes === null ? null : Number(row.database_bytes),
				objectCount: row.object_count === null ? null : Number(row.object_count),
				offsiteCopied: row.offsite_copied === true,
				durationSeconds: row.duration_seconds === null ? null : Number(row.duration_seconds),
				location: (row.location as string | null) ?? null,
				message: (row.message as string | null) ?? null,
			})),
		},
		queues,
	};
}

export type GeoOpsMetrics = Awaited<ReturnType<typeof getOpsMetrics>>;

/** Whether this principal can open the admin settings at all, for the page to decide what to show. */
export function canAdminister(principal: GeoPrincipal): boolean {
	return principalCan(principal, "settings.read");
}
