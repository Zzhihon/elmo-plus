import { secretAad, secretNameFromRef } from "@workspace/geo-cn-providers";
import { db } from "@workspace/lib/db/db";
import { secrets } from "@workspace/lib/db/schema";
import { decryptSecret, getKeyring } from "@workspace/lib/secrets";
import { eq } from "drizzle-orm";

/**
 * Null when the reference is missing, malformed or will not decrypt; the adapter then
 * reports the target as unconfigured. The reason is logged without the value.
 */
export async function loadTargetCredential(ref: string | null): Promise<string | null> {
	const name = secretNameFromRef(ref);
	if (!name) return null;
	const keyring = getKeyring();
	if (!keyring) return null;
	const [row] = await db
		.select({ encryptedValue: secrets.encryptedValue })
		.from(secrets)
		.where(eq(secrets.name, name))
		.limit(1);
	if (!row) return null;
	try {
		return await decryptSecret(row.encryptedValue, { keyring, aad: secretAad(name) });
	} catch (error) {
		console.error(
			`[geo-sampling] credential ${name} will not decrypt (${error instanceof Error ? error.name : "error"})`,
		);
		return null;
	}
}
