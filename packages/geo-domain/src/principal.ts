import type { GeoActorKind } from "./enums";
import { GeoError } from "./errors";
import {
	can,
	type GeoAccess,
	type GeoPermission,
	type GeoRole,
	isGeoRole,
	permissionAccess,
	permissionNeedsSecondFactor,
} from "./permissions";
import type { GeoTransitionActor } from "./transition";

export interface GeoPrincipal {
	organizationId: string;
	/**
	 * The person answerable for the action: a better-auth user id, including for a key,
	 * which acts as the admin who issued it. `instance-admin` or `system:<source>` otherwise.
	 */
	actorId: string;
	actorKind: GeoActorKind;
	/** The key that made the call, for the audit trail; `actorId` is who answers for it. */
	apiKeyId?: string;
	roles: readonly GeoRole[];
	requestId: string;
	/** Set only for key-based callers. Narrows what the roles would otherwise allow. */
	scopes?: readonly GeoAccess[];
	/** The signed-in session behind a `user`. */
	sessionId?: string;
	/** Set only for a `user` whose session meets the organization's second-factor rule. */
	secondFactorSatisfied?: boolean;
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

function hasAuthority(principal: GeoPrincipal, permission: GeoPermission): boolean {
	if (!can(principal.roles, permission)) return false;
	return principal.scopes === undefined || principal.scopes.includes(permissionAccess(permission));
}

function lacksSecondFactor(principal: GeoPrincipal, permission: GeoPermission): boolean {
	return permissionNeedsSecondFactor(permission) && principal.secondFactorSatisfied !== true;
}

/**
 * The one gate for every permission check, on both the server function and the core
 * side, so a sensitive administrative action cannot be reached by forgetting a guard.
 */
export function principalCan(principal: GeoPrincipal, permission: GeoPermission): boolean {
	return hasAuthority(principal, permission) && !lacksSecondFactor(principal, permission);
}

export function assertGeoPermission(principal: GeoPrincipal, permission: GeoPermission): void {
	if (!hasAuthority(principal, permission)) {
		throw new GeoError("FORBIDDEN", "当前账号没有执行此操作的权限");
	}
	if (lacksSecondFactor(principal, permission)) {
		throw new GeoError("FORBIDDEN", "此操作要求本次登录完成两步验证：请先到“设置 › 安全”完成验证");
	}
}

export function transitionActorOf(principal: GeoPrincipal): GeoTransitionActor {
	if (principal.actorKind === "system") return { kind: "system" };
	return { kind: "principal", id: principal.actorId, roles: principal.roles };
}
