import { GeoError, isGeoCredentialRef } from "@workspace/geo-domain";
import { eq, sql } from "drizzle-orm";
import { decodeProtectedHeader } from "jose";
import type { DbConnection } from "../db/db-connection";
import { secrets } from "../db/schema";
import { decryptSecret, ENCRYPTION_KEY_ENV, encryptSecret, getKeyring, type Keyring, keyId } from "../secrets/crypto";

/**
 * The one store for GEO sampling target credentials, whether set in the settings page or
 * directly on a target, kept in the same `secrets` table and under the same keyring as
 * provider credentials. The org id is part of the row name and of the AEAD context, so
 * one organization's ciphertext cannot be replayed under another's name, and a target's
 * reference cannot name anything outside its organization. Nothing here ever returns a
 * value except `resolveGeoCredential`, for making the calls a target exists to make.
 */

const MAX_VALUE_LENGTH = 8192;

export { isGeoCredentialRef };

function assertRef(ref: string): void {
	if (!isGeoCredentialRef(ref)) {
		throw new GeoError("VALIDATION_ERROR", "密钥引用名只能包含大写字母、数字和下划线，以字母开头，2 到 64 个字符");
	}
}

function prefixOf(organizationId: string): string {
	return `geo:${organizationId}:`;
}

export function geoCredentialName(organizationId: string, ref: string): string {
	assertRef(ref);
	return `${prefixOf(organizationId)}${ref}`;
}

function aadFor(name: string): string {
	return `secret:${name}`;
}

function requireKeyring(): Keyring {
	const keyring = getKeyring();
	if (!keyring) throw new GeoError("TARGET_UNAVAILABLE", `${ENCRYPTION_KEY_ENV} 未配置，无法加密保存密钥`);
	return keyring;
}

function payloadKeyId(payload: string): string | null {
	try {
		const kid = decodeProtectedHeader(payload).kid;
		return typeof kid === "string" ? kid : null;
	} catch {
		return null;
	}
}

export interface GeoCredentialSummary {
	ref: string;
	createdAt: Date;
	updatedAt: Date;
	/** Id of the encryption key, never the key or the value. */
	keyId: string | null;
	/** Encrypted under a key that is no longer the primary one, so re-encrypting finishes a key rotation. */
	needsReencryption: boolean;
}

async function rowsFor(db: DbConnection, organizationId: string) {
	const prefix = prefixOf(organizationId);
	return db
		.select()
		.from(secrets)
		.where(sql`left(${secrets.name}, ${prefix.length}) = ${prefix}`)
		.orderBy(secrets.name);
}

export async function listGeoCredentials(db: DbConnection, organizationId: string): Promise<GeoCredentialSummary[]> {
	const keyring = getKeyring();
	const primary = keyring ? keyId(keyring.primary) : null;
	const rows = await rowsFor(db, organizationId);
	return rows.map((row) => {
		const kid = payloadKeyId(row.encryptedValue);
		return {
			ref: row.name.slice(prefixOf(organizationId).length),
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
			keyId: kid,
			needsReencryption: primary !== null && kid !== primary,
		};
	});
}

/** Answers whether the reference was new. Pass the transaction that writes the audit row. */
export async function putGeoCredential(
	db: DbConnection,
	organizationId: string,
	ref: string,
	value: string,
): Promise<{ created: boolean }> {
	const name = geoCredentialName(organizationId, ref);
	if (value.trim().length === 0) throw new GeoError("VALIDATION_ERROR", "密钥值不能为空");
	if (value.length > MAX_VALUE_LENGTH) throw new GeoError("VALIDATION_ERROR", "密钥值过长");
	const encryptedValue = await encryptSecret(value, { key: requireKeyring().primary, aad: aadFor(name) });

	const [existing] = await db.select({ name: secrets.name }).from(secrets).where(eq(secrets.name, name)).limit(1);
	await db
		.insert(secrets)
		.values({ name, encryptedValue })
		.onConflictDoUpdate({ target: secrets.name, set: { encryptedValue, updatedAt: new Date() } });
	return { created: !existing };
}

export async function deleteGeoCredential(db: DbConnection, organizationId: string, ref: string): Promise<boolean> {
	const rows = await db
		.delete(secrets)
		.where(eq(secrets.name, geoCredentialName(organizationId, ref)))
		.returning({ name: secrets.name });
	return rows.length > 0;
}

/**
 * Finishes an `ELMO_ENCRYPTION_KEY` rotation for this organization: whatever is
 * still under a retired key is decrypted and written back under the primary one.
 * A row that will not decrypt is counted and left alone rather than overwritten.
 */
export async function reencryptGeoCredentials(
	db: DbConnection,
	organizationId: string,
): Promise<{ reencrypted: number; failed: number }> {
	const keyring = requireKeyring();
	const primary = keyId(keyring.primary);
	let reencrypted = 0;
	let failed = 0;
	for (const row of await rowsFor(db, organizationId)) {
		if (payloadKeyId(row.encryptedValue) === primary) continue;
		try {
			const value = await decryptSecret(row.encryptedValue, { keyring, aad: aadFor(row.name) });
			const encryptedValue = await encryptSecret(value, { key: keyring.primary, aad: aadFor(row.name) });
			await db.update(secrets).set({ encryptedValue, updatedAt: new Date() }).where(eq(secrets.name, row.name));
			reencrypted += 1;
		} catch {
			failed += 1;
		}
	}
	return { reencrypted, failed };
}

/** For the sampling adapters. Null when the reference is unset or will not decrypt. */
export async function resolveGeoCredential(
	db: DbConnection,
	organizationId: string,
	ref: string,
): Promise<string | null> {
	if (!isGeoCredentialRef(ref)) return null;
	const keyring = getKeyring();
	if (!keyring) return null;
	const name = geoCredentialName(organizationId, ref);
	const [row] = await db
		.select({ encryptedValue: secrets.encryptedValue })
		.from(secrets)
		.where(eq(secrets.name, name))
		.limit(1);
	if (!row) return null;
	try {
		return await decryptSecret(row.encryptedValue, { keyring, aad: aadFor(name) });
	} catch (error) {
		console.error(`[geo] credential ${ref} will not decrypt (${error instanceof Error ? error.name : "error"})`);
		return null;
	}
}
