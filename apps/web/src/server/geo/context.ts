import { randomUUID } from "node:crypto";
import { isGeoWorkspaceEnabled } from "@workspace/config/geo";
import { getDeployment } from "@workspace/deployment";
import {
	assertGeoPermission,
	GeoError,
	type GeoPermission,
	type GeoPrincipal,
	permissionAccess,
	rolesForApiKeyScopes,
} from "@workspace/geo-domain";
import { db } from "@workspace/lib/db/db";
import { member, organization } from "@workspace/lib/db/schema";
import { resolveGeoApiKeyOwner } from "@workspace/lib/geo/api-key-owners";
import { loadGeoMemberRoles } from "@workspace/lib/geo/roles";
import { loadGeoSecondFactorState } from "@workspace/lib/geo/session-factor";
import { and, eq, or } from "drizzle-orm";
import { geoApiScope } from "@/lib/api/scopes";
import type { ApiAuth, OrganizationAuth, Principal } from "@/lib/auth/api-auth";
import { READ_ONLY_MESSAGE } from "@/lib/read-only-errors";

const ADMIN_ORGANIZATION_HEADER = "X-Geo-Organization-Id";
const REQUEST_ID_SHAPE = /^[A-Za-z0-9._-]{8,128}$/;

export function geoRequestId(request?: Request): string {
	const supplied = request?.headers.get("X-Request-Id");
	return supplied && REQUEST_ID_SHAPE.test(supplied) ? supplied : randomUUID();
}

function assertEnabled(): void {
	if (!isGeoWorkspaceEnabled()) throw new GeoError("NOT_FOUND", "GEO 工作台未启用");
}

/**
 * An organization key gets the operator's hands at most, however broad, and writes as
 * the admin who issued it, so what it enters is that person's to answer for and not
 * theirs to approve. An instance admin key has nobody to answer for it, so it only
 * reads; it reaches every organization, so it has to name the one it is reading. A key
 * narrowed to some brands gets no GEO access: everything here is organization-wide and
 * would overstep the narrowing.
 */
export async function resolveGeoApiPrincipal(
	auth: ApiAuth,
	request: Request,
	requestId: string,
): Promise<GeoPrincipal> {
	if (auth.kind === "admin") {
		const organizationId = request.headers.get(ADMIN_ORGANIZATION_HEADER);
		if (!organizationId) {
			throw new GeoError("VALIDATION_ERROR", `实例管理密钥必须通过 ${ADMIN_ORGANIZATION_HEADER} 指定组织`);
		}
		const [row] = await db
			.select({ id: organization.id })
			.from(organization)
			.where(eq(organization.id, organizationId))
			.limit(1);
		if (!row) throw new GeoError("NOT_FOUND", "组织不存在");
		return {
			organizationId,
			actorId: "instance-admin",
			actorKind: "instance_admin_key",
			roles: rolesForApiKeyScopes(["read"]),
			requestId,
			scopes: ["read"],
		};
	}

	return resolveGeoKeyPrincipal(auth, requestId);
}

async function resolveGeoKeyPrincipal(auth: OrganizationAuth, requestId: string): Promise<GeoPrincipal> {
	if (auth.brandIds !== null) {
		throw new GeoError("FORBIDDEN", "限定品牌范围的 API Key 不能访问 GEO 工作台");
	}
	const ownerId = await resolveGeoApiKeyOwner(db, auth.keyId, auth.organizationId);
	if (!ownerId) throw new GeoError("FORBIDDEN", "此 API Key 的签发人已不是本组织管理员，不能访问 GEO 工作台");
	const scopes = (["read", "write"] as const).filter((access) => auth.scopes.has(geoApiScope(access)));
	return {
		organizationId: auth.organizationId,
		actorId: ownerId,
		actorKind: "api_key",
		apiKeyId: auth.keyId,
		roles: rolesForApiKeyScopes(scopes),
		requestId,
		scopes,
	};
}

/** Over MCP only an organization key, which carries its own GEO grant, reaches the workspace. */
export async function resolveGeoMcpPrincipal(auth: Principal): Promise<GeoPrincipal> {
	assertEnabled();
	if (auth.kind !== "organization") {
		throw new GeoError("FORBIDDEN", "GEO 工具只能通过开通了 GEO 权限的组织 API Key 使用");
	}
	return resolveGeoKeyPrincipal(auth, randomUUID());
}

async function findMemberOrganizationId(userId: string, idOrSlug: string): Promise<string | null> {
	const rows = await db
		.select({ id: organization.id, slug: organization.slug })
		.from(organization)
		.innerJoin(member, and(eq(member.organizationId, organization.id), eq(member.userId, userId)))
		.where(or(eq(organization.id, idOrSlug), eq(organization.slug, idOrSlug)));
	// Same precedence as resolveSegment: a slug wins over an id that happens to match it.
	return (rows.find((row) => row.slug === idOrSlug) ?? rows[0])?.id ?? null;
}

/** The signed-in person's roles in an organization, with no particular permission demanded. */
export async function resolveGeoSessionPrincipal(idOrSlug: string, request?: Request): Promise<GeoPrincipal> {
	assertEnabled();
	// Loaded on demand so REST modules, which never use a session, do not start Better Auth on import.
	const { getAuthSession } = await import("@/lib/auth/helpers");
	const session = await getAuthSession();
	if (!session) throw new GeoError("UNAUTHORIZED", "请先登录");

	const notReachable = () => new GeoError("NOT_FOUND", "组织不存在");
	const organizationId = await findMemberOrganizationId(session.user.id, idOrSlug);
	if (!organizationId) throw notReachable();
	const roles = await loadGeoMemberRoles(db, organizationId, session.user.id);
	if (!roles) throw notReachable();

	const sessionId = session.session.id;
	const secondFactor = roles.includes("platform_admin")
		? await loadGeoSecondFactorState(db, { organizationId, userId: session.user.id, sessionId })
		: null;
	return {
		organizationId,
		actorId: session.user.id,
		actorKind: "user",
		roles,
		requestId: geoRequestId(request),
		sessionId,
		secondFactorSatisfied: secondFactor?.satisfied ?? false,
	};
}

/**
 * For server functions and session-authenticated server routes. Refuses a write in a read-only deployment, which the REST path gets
 * from `createApiHandler`.
 */
export async function requireGeoServerFnPrincipal(
	idOrSlug: string,
	permission: GeoPermission,
	request?: Request,
): Promise<GeoPrincipal> {
	const principal = await resolveGeoSessionPrincipal(idOrSlug, request);
	assertGeoPermission(principal, permission);
	if (permissionAccess(permission) === "write" && getDeployment().features.readOnly) {
		throw new GeoError("FORBIDDEN", READ_ONLY_MESSAGE);
	}
	return principal;
}
