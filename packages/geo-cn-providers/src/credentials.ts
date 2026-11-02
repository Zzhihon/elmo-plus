export const GEO_TARGET_SECRET_PREFIX = "geo-target:";
const REF_PREFIX = "secret:";
const SECRET_NAME_SHAPE = /^[A-Za-z0-9_.:-]{1,128}$/;

/** The `secrets` row that holds a target's credential. Not an env-var name, so the provider overlay never loads it. */
export function targetSecretName(targetId: string): string {
	return `${GEO_TARGET_SECRET_PREFIX}${targetId}`;
}

export function credentialRefFor(secretName: string): string {
	return `${REF_PREFIX}${secretName}`;
}

/** The secret name a `credential_ref` points at, or null when the reference is malformed. */
export function secretNameFromRef(ref: string | null | undefined): string | null {
	if (!ref?.startsWith(REF_PREFIX)) return null;
	const name = ref.slice(REF_PREFIX.length);
	return SECRET_NAME_SHAPE.test(name) ? name : null;
}

/** Matches the additional data the shared secrets store binds every ciphertext to. */
export function secretAad(secretName: string): string {
	return `secret:${secretName}`;
}
