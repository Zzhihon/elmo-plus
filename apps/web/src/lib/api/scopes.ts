/**
 * A key either reads, or it reads and writes. The wire spells a grant as the
 * bare word; better-auth stores it as `{ resource: [action] }` under the one
 * resource below, and the two conversions here are the only bridge.
 *
 * `write` does not imply `read`: a read-write key holds both, so every check
 * downstream stays plain set membership.
 *
 * Nothing finer is offered because nothing finer would be enforcing anything a
 * caller could not already reach: the operations worth withholding — report
 * generation, brand analysis, prompt deletion, every billing write — are
 * admin-only, which is a property of the endpoint rather than a scope somebody
 * could tick.
 */

export const API_SCOPES = ["read", "write"] as const;

/**
 * The GEO workspace is a separate grant, because keys issued before an organization
 * turned it on must not gain sampling spend or publishing when it does. Neither plain
 * scope implies these.
 */
export const GEO_API_SCOPES = ["geo:read", "geo:write"] as const;

export const ALL_API_SCOPES = [...API_SCOPES, ...GEO_API_SCOPES] as const;

export type ApiScope = (typeof ALL_API_SCOPES)[number];

export function geoApiScope(access: "read" | "write"): ApiScope {
	return access === "read" ? "geo:read" : "geo:write";
}

/** The single resource better-auth files every grant under. */
const RESOURCE = "api";

export function permissionsToScopes(permissions: unknown): ApiScope[] {
	if (!permissions || typeof permissions !== "object") return [];
	const actions = (permissions as Record<string, unknown>)[RESOURCE];
	if (!Array.isArray(actions)) return [];
	return ALL_API_SCOPES.filter((scope) => actions.includes(scope));
}

/** Unknown scopes are dropped, not trusted. */
export function scopesToPermissions(scopes: readonly string[]): Record<string, string[]> {
	return { [RESOURCE]: ALL_API_SCOPES.filter((scope) => scopes.includes(scope)) };
}
