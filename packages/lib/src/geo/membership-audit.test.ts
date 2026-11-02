import { describe, expect, it, vi } from "vitest";
import type { DbConnection } from "../db/db-connection";

const written = vi.hoisted(() => [] as { action: string }[]);
vi.mock("./audit", () => ({ writeGeoAudit: async (_db: unknown, entry: { action: string }) => written.push(entry) }));

const { auditGeoMembershipChange } = await import("./membership-audit");
const db = {} as DbConnection;

describe("auditing membership changes", () => {
	it("records gaining and losing organization admin standing", async () => {
		written.length = 0;
		await auditGeoMembershipChange(db, { organizationId: "o", userId: "u", previousRole: "member", role: "admin" });
		await auditGeoMembershipChange(db, { organizationId: "o", userId: "u", previousRole: "owner", role: null });
		expect(written.map((entry) => entry.action)).toEqual(["rbac.platform_admin.gain", "rbac.platform_admin.lose"]);
	});

	it("leaves out changes that do not touch it", async () => {
		written.length = 0;
		await auditGeoMembershipChange(db, { organizationId: "o", userId: "u", previousRole: null, role: "member" });
		await auditGeoMembershipChange(db, { organizationId: "o", userId: "u", previousRole: "admin", role: "owner" });
		expect(written).toEqual([]);
	});
});
