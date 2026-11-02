import { db } from "@workspace/lib/db/db";
import { resolveGeoCredential } from "@workspace/lib/geo/credentials";

/**
 * Null when the reference is missing, or names nothing this organization holds, or will
 * not decrypt; the adapter then reports the target as unconfigured. The organization is
 * part of the name looked up, so a target cannot reach anyone else's secret.
 */
export async function loadTargetCredential(organizationId: string, ref: string | null): Promise<string | null> {
	return ref ? resolveGeoCredential(db, organizationId, ref) : null;
}
