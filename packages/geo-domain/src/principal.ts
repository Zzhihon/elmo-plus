import type { GeoActorKind } from "./enums";
import { GeoError } from "./errors";
import { can, type GeoAccess, type GeoPermission, type GeoRole, isGeoRole, permissionAccess } from "./permissions";
import type { GeoTransitionActor } from "./transition";

export interface GeoPrincipal {
	organizationId: string;
	/** A better-auth user id for `user`; `apikey:<id>`, `instance-admin` or `system:<source>` otherwise. */
	actorId: string;
	actorKind: GeoActorKind;
	roles: readonly GeoRole[];
	requestId: string;
	/** Set only for key-based callers. Narrows what the roles would otherwise allow. */
	scopes?: readonly GeoAccess[];
}

const ORG_ADMIN_MEMBER_ROLES = new Set(["owner", "admin"]);

/** better-auth stores several roles on one member as a comma-separated string. */
export function rolesForMember(memberRole: string, assigned: readonly string[]): GeoRole[] {
	const memberRoles = memberRole.split(",").map((role) => role.trim());
	const roles = new Set<GeoRole>(assigned.filter(isGeoRole));
	if (memberRoles.some((role) => ORG_ADMIN_MEMBER_ROLES.has(role))) roles.add("platform_admin");
	if (roles.size === 0) roles.add("viewer");
	return [...roles];
}

/**
 * A key has no person behind it, so it can never hold a review or administration
 * role: separation of duties depends on knowing who approved what.
 */
export function rolesForApiKeyScopes(scopes: readonly GeoAccess[]): GeoRole[] {
	const roles: GeoRole[] = [];
	if (scopes.includes("read")) roles.push("viewer");
	if (scopes.includes("write")) roles.push("geo_operator");
	return roles;
}

export function geoSystemPrincipal(organizationId: string, source: string, requestId: string): GeoPrincipal {
	return { organizationId, actorId: `system:${source}`, actorKind: "system", roles: [], requestId };
}

export function principalCan(principal: GeoPrincipal, permission: GeoPermission): boolean {
	if (!can(principal.roles, permission)) return false;
	return principal.scopes === undefined || principal.scopes.includes(permissionAccess(permission));
}

export function assertGeoPermission(principal: GeoPrincipal, permission: GeoPermission): void {
	if (!principalCan(principal, permission)) {
		throw new GeoError("FORBIDDEN", "当前账号没有执行此操作的权限");
	}
}

export function transitionActorOf(principal: GeoPrincipal): GeoTransitionActor {
	if (principal.actorKind === "system") return { kind: "system" };
	return { kind: "principal", id: principal.actorId, roles: principal.roles };
}
