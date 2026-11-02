import { describe, expect, it } from "vitest";
import { can, GEO_PERMISSIONS, GEO_ROLES, type GeoPermission, permissionAccess } from "./permissions";
import {
	assertGeoPermission,
	type GeoPrincipal,
	principalCan,
	rolesForApiKeyScopes,
	rolesForMember,
} from "./principal";

const REVIEW_OR_ADMIN: GeoPermission[] = GEO_PERMISSIONS.filter(
	(permission) =>
		permission.includes("review") ||
		permission.startsWith("rbac.") ||
		permission.startsWith("settings.") ||
		permission.startsWith("secret.") ||
		permission.startsWith("audit.") ||
		permission.startsWith("llm.") ||
		permission.endsWith(".manage"),
);

function keyPrincipal(scopes: ("read" | "write")[]): GeoPrincipal {
	return {
		organizationId: "org",
		actorId: "user-admin",
		actorKind: "api_key",
		roles: rolesForApiKeyScopes(scopes),
		requestId: "req",
		scopes,
	};
}

describe("member roles", () => {
	it("treats an organization owner or admin as a platform admin", () => {
		expect(rolesForMember("owner", [])).toEqual(["platform_admin"]);
		expect(rolesForMember("admin", [])).toEqual(["platform_admin"]);
		expect(rolesForMember("member,admin", [])).toEqual(["platform_admin"]);
	});

	it("leaves a member without an assignment as a viewer", () => {
		expect(rolesForMember("member", [])).toEqual(["viewer"]);
	});

	it("keeps every assigned role and drops anything unknown", () => {
		expect(rolesForMember("member", ["tech_reviewer", "geo_operator", "root"]).sort()).toEqual([
			"geo_operator",
			"tech_reviewer",
		]);
	});
});

describe("API keys", () => {
	it("never reach a review or administration permission, whatever their scopes", () => {
		const principal = keyPrincipal(["read", "write"]);
		expect(REVIEW_OR_ADMIN.filter((permission) => principalCan(principal, permission))).toEqual(
			// alert.manage is the operator's triage of alerts, not administration of the workspace.
			["alert.manage"],
		);
	});

	it("cannot write with a read scope", () => {
		const principal = keyPrincipal(["read"]);
		const writes = GEO_PERMISSIONS.filter((permission) => permissionAccess(permission) === "write");
		expect(writes.filter((permission) => principalCan(principal, permission))).toEqual([]);
		expect(principalCan(principal, "observation.read")).toBe(true);
	});

	it("cannot read with a write scope", () => {
		const principal = keyPrincipal(["write"]);
		expect(principalCan(principal, "observation.read")).toBe(false);
		expect(principalCan(principal, "sampling.run")).toBe(true);
	});

	it("hold nothing without a scope", () => {
		const principal = keyPrincipal([]);
		expect(GEO_PERMISSIONS.filter((permission) => principalCan(principal, permission))).toEqual([]);
	});
});

describe("separation of duties", () => {
	it("gives administrators no approval or publishing power", () => {
		for (const permission of [
			"task.review_tech",
			"task.review_marketing",
			"task.publish",
			"content.review_tech",
			"content.review_marketing",
			"content.publish",
			"knowledge.review",
			"observation.review",
		] as const) {
			expect(can(["platform_admin"], permission), permission).toBe(false);
		}
	});

	it("keeps operators out of reviews and secrets", () => {
		expect(can(["geo_operator"], "task.review_tech")).toBe(false);
		expect(can(["geo_operator"], "knowledge.review")).toBe(false);
		expect(can(["geo_operator"], "secret.manage")).toBe(false);
	});

	it("keeps a viewer read-only and away from raw snapshots and the audit log", () => {
		const writes = GEO_PERMISSIONS.filter((permission) => permissionAccess(permission) === "write");
		expect(writes.filter((permission) => can(["viewer"], permission))).toEqual([]);
		expect(can(["viewer"], "site.read_snapshot")).toBe(false);
		expect(can(["viewer"], "audit.read")).toBe(false);
		expect(can(["viewer"], "knowledge.read_confidential")).toBe(false);
	});

	it("grants every permission to at least one role", () => {
		const unreachable = GEO_PERMISSIONS.filter((permission) => !GEO_ROLES.some((role) => can([role], permission)));
		expect(unreachable).toEqual([]);
	});
});

describe("a session's second factor", () => {
	const admin = (secondFactorSatisfied?: boolean): GeoPrincipal => ({
		organizationId: "org",
		actorId: "user",
		actorKind: "user",
		roles: ["platform_admin"],
		requestId: "req",
		secondFactorSatisfied,
	});

	it.each([
		"brand.manage",
		"target.manage",
		"site.manage",
		"settings.manage",
		"rbac.manage",
		"secret.manage",
		"llm.approve",
	] as const)("guards %s", (permission) => {
		expect(principalCan(admin(), permission)).toBe(false);
		expect(() => assertGeoPermission(admin(false), permission)).toThrow(/两步验证/);
		expect(principalCan(admin(true), permission)).toBe(true);
	});

	it("does not stand in the way of ordinary reads and work", () => {
		expect(principalCan(admin(), "brand.read")).toBe(true);
		expect(principalCan(admin(), "site.crawl")).toBe(true);
	});

	it("still says no first to someone without the role", () => {
		const viewer: GeoPrincipal = { ...admin(true), roles: ["viewer"] };
		expect(() => assertGeoPermission(viewer, "secret.manage")).toThrow(/没有执行此操作的权限/);
	});
});
