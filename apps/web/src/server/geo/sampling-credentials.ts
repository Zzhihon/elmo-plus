import { db } from "@workspace/lib/db/db";
import { listGeoCredentials, resolveGeoCredential } from "@workspace/lib/geo/credentials";

/** Which of this organization's references have a stored value; the values themselves never leave the server. */
export async function storedCredentialRefs(organizationId: string): Promise<Set<string>> {
	const credentials = await listGeoCredentials(db, organizationId);
	return new Set(credentials.map((credential) => credential.ref));
}

/** For the connectivity check only. Null when missing or unreadable, which the adapter reports as unconfigured. */
export async function readTargetCredential(organizationId: string, ref: string | null): Promise<string | null> {
	return ref ? resolveGeoCredential(db, organizationId, ref) : null;
}
