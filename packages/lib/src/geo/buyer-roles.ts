import { GEO_DEFAULT_BUYER_ROLES } from "@workspace/geo-domain";
import { asc, eq } from "drizzle-orm";
import type { DbConnection } from "../db/db-connection";
import { geoBuyerRoles } from "../db/schema-geo";

export type GeoBuyerRole = typeof geoBuyerRoles.$inferSelect;

export async function seedDefaultBuyerRoles(db: DbConnection, organizationId: string): Promise<void> {
	await db
		.insert(geoBuyerRoles)
		.values(GEO_DEFAULT_BUYER_ROLES.map((role) => ({ ...role, organizationId })))
		.onConflictDoNothing();
}

export async function listBuyerRolesSeeded(db: DbConnection, organizationId: string): Promise<GeoBuyerRole[]> {
	const list = () =>
		db
			.select()
			.from(geoBuyerRoles)
			.where(eq(geoBuyerRoles.organizationId, organizationId))
			.orderBy(asc(geoBuyerRoles.priority), asc(geoBuyerRoles.code));
	const roles = await list();
	if (roles.length > 0) return roles;
	await seedDefaultBuyerRoles(db, organizationId);
	return list();
}
