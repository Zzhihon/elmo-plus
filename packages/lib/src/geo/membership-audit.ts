import { randomUUID } from "node:crypto";
import { geoSystemPrincipal } from "@workspace/geo-domain";
import type { DbConnection } from "../db/db-connection";
import { writeGeoAudit } from "./audit";

const ADMIN_ROLES = new Set(["owner", "admin"]);

function holdsAdmin(role: string | null | undefined): boolean {
	return (role ?? "").split(",").some((part) => ADMIN_ROLES.has(part.trim()));
}

/**
 * An organization owner or admin is a GEO platform administrator without any GEO grant,
 * so a membership change that gives or takes that standing is a permission change and
 * goes in the GEO audit log beside the explicit grants.
 */
export async function auditGeoMembershipChange(
	db: DbConnection,
	change: { organizationId: string; userId: string; previousRole: string | null; role: string | null },
): Promise<void> {
	if (holdsAdmin(change.previousRole) === holdsAdmin(change.role)) return;
	await writeGeoAudit(db, {
		principal: geoSystemPrincipal(change.organizationId, "membership", randomUUID()),
		action: holdsAdmin(change.role) ? "rbac.platform_admin.gain" : "rbac.platform_admin.lose",
		entityType: "member",
		entityId: change.userId,
		before: { role: change.previousRole },
		after: { role: change.role },
		metadata: { previousRole: change.previousRole, role: change.role },
	});
}
