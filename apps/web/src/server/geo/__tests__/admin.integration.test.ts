import type { GeoPrincipal } from "@workspace/geo-domain";
import { db } from "@workspace/lib/db/db";
import { geoRetentionConfigs } from "@workspace/lib/geo/maintenance";
import { beforeAll, describe, expect, it } from "vitest";
import {
	changeRole,
	createAdminRequest,
	decideRequest,
	getOpsMetrics,
	getSettings,
	listAdminRequests,
	listAlerts,
	listAuditLogs,
	listMembers,
	previewRetention,
	revokeLlmUse,
	securityStatus,
} from "@/server/geo/admin-core";
import { createGeoOrganization, expectGeoError } from "@/test/integration/geo-fixtures";

let organizationId: string;
let requester: GeoPrincipal;
let approver: GeoPrincipal;
let colleague: GeoPrincipal;

const retention = { evidenceRetentionDays: 400, snapshotRetentionDays: 400, auditRetentionDays: 730 };

beforeAll(async () => {
	const org = await createGeoOrganization();
	organizationId = org.organizationId;
	requester = await org.actor(["platform_admin"], "管理员甲");
	approver = await org.actor(["platform_admin"], "管理员乙");
	colleague = await org.actor(["geo_operator"], "运营");
});

describe("dual-control settings", () => {
	it("applies a retention change only after a second administrator approves it", async () => {
		await expectGeoError(
			createAdminRequest(requester, {
				kind: "RETENTION_CHANGE",
				reason: "过短",
				retention: { ...retention, auditRetentionDays: 30 },
			}),
			"VALIDATION_ERROR",
		);
		const request = await createAdminRequest(requester, { kind: "RETENTION_CHANGE", reason: "合同要求", retention });
		await expectGeoError(
			createAdminRequest(requester, { kind: "RETENTION_CHANGE", reason: "重复", retention }),
			"CONFLICT",
		);
		await expectGeoError(decideRequest(requester, { requestId: request.id, decision: "APPROVE" }), "FORBIDDEN");
		expect((await getSettings(requester)).evidenceRetentionDays).toBeNull();

		await decideRequest(approver, { requestId: request.id, decision: "APPROVE", comment: "同意" });
		expect(await getSettings(requester)).toMatchObject(retention);
		expect((await geoRetentionConfigs(db)).find((row) => row.organizationId === organizationId)).toMatchObject(
			retention,
		);
		const preview = await previewRetention(requester, retention);
		expect(preview.map((row) => row.category)).toEqual(["evidence", "snapshot", "audit"]);
		expect((await listAdminRequests(requester))[0]).toMatchObject({ status: "APPROVED", decidedBy: approver.actorId });
	});

	it("needs two administrators to approve model use, and one to withdraw it", async () => {
		const request = await createAdminRequest(requester, { kind: "LLM_USE_APPROVAL", reason: "启用语义评估" });
		await decideRequest(approver, { requestId: request.id, decision: "APPROVE" });
		expect((await getSettings(requester)).llmUseApproved).toBe(true);
		expect((await revokeLlmUse(requester)).llmUseApproved).toBe(false);
	});

	it("audits role grants and serves the operations views", async () => {
		await expectGeoError(
			changeRole(colleague, { userId: colleague.actorId, role: "tech_reviewer", grant: true }),
			"FORBIDDEN",
		);
		await changeRole(requester, { userId: colleague.actorId, role: "tech_reviewer", grant: true });
		const members = await listMembers(requester);
		expect(members.find((row) => row.userId === colleague.actorId)?.assigned).toEqual(
			expect.arrayContaining(["tech_reviewer"]),
		);
		const audit = await listAuditLogs(requester, { action: "settings.retention_change" }, { limit: 20, offset: 0 });
		expect(audit.total).toBe(1);
		await listAlerts(requester, true);
		await getOpsMetrics(requester);
		expect(await securityStatus(requester)).toMatchObject({ adminMfaRequired: true, hasPassword: false });
	});
});
