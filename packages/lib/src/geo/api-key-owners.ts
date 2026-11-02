import { isOrgAdminRole } from "@workspace/config/roles";
import { and, eq } from "drizzle-orm";
import type { DbConnection } from "../db/db-connection";
import { member } from "../db/schema-auth";
import { geoApiKeyOwners } from "../db/schema-geo";

export async function recordGeoApiKeyOwner(
	db: DbConnection,
	input: { keyId: string; organizationId: string; userId: string },
): Promise<void> {
	await db.insert(geoApiKeyOwners).values(input);
}

/**
 * The person answerable for a key, or null when it has no such person any more.
 * Only an organization admin can issue a key, so one who has since lost that standing
 * or left takes the key's GEO access with them.
 */
export async function resolveGeoApiKeyOwner(
	db: DbConnection,
	keyId: string,
	organizationId: string,
): Promise<string | null> {
	const [row] = await db
		.select({ userId: geoApiKeyOwners.userId, role: member.role })
		.from(geoApiKeyOwners)
		.leftJoin(
			member,
			and(eq(member.organizationId, geoApiKeyOwners.organizationId), eq(member.userId, geoApiKeyOwners.userId)),
		)
		.where(and(eq(geoApiKeyOwners.keyId, keyId), eq(geoApiKeyOwners.organizationId, organizationId)))
		.limit(1);
	return row && isOrgAdminRole(row.role) ? row.userId : null;
}
