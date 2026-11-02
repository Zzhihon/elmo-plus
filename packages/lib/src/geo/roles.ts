import { type GeoRole, rolesForMember } from "@workspace/geo-domain";
import { and, eq } from "drizzle-orm";
import type { DbConnection } from "../db/db-connection";
import { member } from "../db/schema-auth";
import { geoRoleAssignments } from "../db/schema-geo";

/** Null means the user is not a member of the organization at all. */
export async function loadGeoMemberRoles(
	db: DbConnection,
	organizationId: string,
	userId: string,
): Promise<GeoRole[] | null> {
	const [membership] = await db
		.select({ role: member.role })
		.from(member)
		.where(and(eq(member.organizationId, organizationId), eq(member.userId, userId)))
		.limit(1);
	if (!membership) return null;

	const assignments = await db
		.select({ role: geoRoleAssignments.role })
		.from(geoRoleAssignments)
		.where(and(eq(geoRoleAssignments.organizationId, organizationId), eq(geoRoleAssignments.userId, userId)));

	return rolesForMember(
		membership.role,
		assignments.map((assignment) => assignment.role),
	);
}
