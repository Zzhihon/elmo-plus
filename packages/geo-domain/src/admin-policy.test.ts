import { describe, expect, it } from "vitest";
import { decideAdminRequest, type GeoAdminRequestFacts, retentionCutoff, retentionProblem } from "./admin-policy";
import type { GeoTransitionActor } from "./transition";

const NOW = new Date("2026-06-01T00:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

function request(overrides: Partial<GeoAdminRequestFacts> = {}): GeoAdminRequestFacts {
	return {
		kind: "LLM_USE_APPROVAL",
		status: "PENDING",
		requestedBy: "admin-a",
		expiresAt: new Date(NOW.getTime() + DAY),
		...overrides,
	};
}

const adminA: GeoTransitionActor = { kind: "principal", id: "admin-a", roles: ["platform_admin"] };
const adminB: GeoTransitionActor = { kind: "principal", id: "admin-b", roles: ["platform_admin"] };
const operator: GeoTransitionActor = { kind: "principal", id: "op", roles: ["geo_operator"] };

describe("decideAdminRequest", () => {
	it("lets a second administrator approve", () => {
		expect(decideAdminRequest({ request: request(), decision: "APPROVE", actor: adminB, now: NOW })).toEqual({
			ok: true,
			to: "APPROVED",
		});
	});

	it("never lets the requester approve their own change, even as an administrator", () => {
		const result = decideAdminRequest({ request: request(), decision: "APPROVE", actor: adminA, now: NOW });
		expect(result).toMatchObject({ ok: false, code: "FORBIDDEN" });
	});

	it("refuses someone without the approval permission", () => {
		const result = decideAdminRequest({ request: request(), decision: "APPROVE", actor: operator, now: NOW });
		expect(result).toMatchObject({ ok: false, code: "FORBIDDEN" });
	});

	it("refuses a decision on an expired or already decided request", () => {
		const expired = request({ expiresAt: new Date(NOW.getTime() - 1) });
		expect(decideAdminRequest({ request: expired, decision: "APPROVE", actor: adminB, now: NOW })).toMatchObject({
			ok: false,
			code: "CONFLICT",
		});
		const decided = request({ status: "APPROVED" });
		expect(decideAdminRequest({ request: decided, decision: "REJECT", actor: adminB, now: NOW })).toMatchObject({
			ok: false,
			code: "CONFLICT",
		});
	});

	it("requires a comment to reject", () => {
		expect(decideAdminRequest({ request: request(), decision: "REJECT", actor: adminB, now: NOW })).toMatchObject({
			ok: false,
			code: "VALIDATION_ERROR",
		});
		expect(
			decideAdminRequest({ request: request(), decision: "REJECT", actor: adminB, comment: "范围过大", now: NOW }),
		).toEqual({ ok: true, to: "REJECTED" });
	});

	it("lets only the requester withdraw", () => {
		expect(decideAdminRequest({ request: request(), decision: "CANCEL", actor: adminA, now: NOW })).toEqual({
			ok: true,
			to: "CANCELLED",
		});
		expect(decideAdminRequest({ request: request(), decision: "CANCEL", actor: adminB, now: NOW })).toMatchObject({
			ok: false,
			code: "FORBIDDEN",
		});
	});

	it("does not accept a decision from the system", () => {
		expect(
			decideAdminRequest({ request: request(), decision: "APPROVE", actor: { kind: "system" }, now: NOW }),
		).toMatchObject({ ok: false, code: "FORBIDDEN" });
	});
});

describe("retention", () => {
	const none = { evidenceRetentionDays: null, snapshotRetentionDays: null, auditRetentionDays: null };

	it("deletes nothing by default", () => {
		expect(retentionCutoff(none, "evidence", NOW)).toBeNull();
		expect(retentionCutoff(none, "snapshot", NOW)).toBeNull();
		expect(retentionCutoff(none, "audit", NOW)).toBeNull();
	});

	it("puts the cutoff exactly the configured number of days back", () => {
		const settings = { ...none, evidenceRetentionDays: 90 };
		expect(retentionCutoff(settings, "evidence", NOW)?.toISOString()).toBe(
			new Date(NOW.getTime() - 90 * DAY).toISOString(),
		);
	});

	it("accepts the minimum and rejects one day less", () => {
		expect(retentionProblem({ ...none, auditRetentionDays: 180 })).toBeNull();
		expect(retentionProblem({ ...none, auditRetentionDays: 179 })).toMatch(/180/);
		expect(retentionProblem({ ...none, evidenceRetentionDays: 30 })).toBeNull();
		expect(retentionProblem({ ...none, evidenceRetentionDays: 29 })).toMatch(/30/);
		expect(retentionProblem({ ...none, snapshotRetentionDays: 1.5 })).toMatch(/整数/);
	});

	it("keeps everything when a stored value is below the minimum rather than deleting more", () => {
		expect(retentionCutoff({ ...none, auditRetentionDays: 7 }, "audit", NOW)).toBeNull();
		expect(retentionCutoff({ ...none, evidenceRetentionDays: 0 }, "evidence", NOW)).toBeNull();
	});
});
