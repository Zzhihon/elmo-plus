import { secretAad, secretNameFromRef } from "@workspace/geo-cn-providers";
import { GeoError } from "@workspace/geo-domain";
import { db } from "@workspace/lib/db/db";
import type { DbConnection } from "@workspace/lib/db/db-connection";
import { secrets } from "@workspace/lib/db/schema";
import { decryptSecret, ENCRYPTION_KEY_ENV, encryptSecret, getKeyring } from "@workspace/lib/secrets";
import { eq, inArray } from "drizzle-orm";

/** Which of these references have a stored value; the values themselves never leave the server. */
export async function storedCredentialNames(refs: readonly (string | null)[]): Promise<Set<string>> {
	const names = refs.map(secretNameFromRef).filter((name): name is string => name !== null);
	if (names.length === 0) return new Set();
	const rows = await db.select({ name: secrets.name }).from(secrets).where(inArray(secrets.name, names));
	return new Set(rows.map((row) => row.name));
}

export async function writeTargetCredential(tx: DbConnection, secretName: string, value: string): Promise<void> {
	const keyring = getKeyring();
	if (!keyring) throw new GeoError("VALIDATION_ERROR", `服务器未设置 ${ENCRYPTION_KEY_ENV}，无法加密保存凭据`);
	const encryptedValue = await encryptSecret(value, { key: keyring.primary, aad: secretAad(secretName) });
	await tx
		.insert(secrets)
		.values({ name: secretName, encryptedValue })
		.onConflictDoUpdate({ target: secrets.name, set: { encryptedValue } });
}

/** For the connectivity check only. Null when missing or unreadable, which the adapter reports as unconfigured. */
export async function readTargetCredential(ref: string | null): Promise<string | null> {
	const name = secretNameFromRef(ref);
	const keyring = getKeyring();
	if (!name || !keyring) return null;
	const [row] = await db.select({ encryptedValue: secrets.encryptedValue }).from(secrets).where(eq(secrets.name, name));
	if (!row) return null;
	try {
		return await decryptSecret(row.encryptedValue, { keyring, aad: secretAad(name) });
	} catch {
		return null;
	}
}
