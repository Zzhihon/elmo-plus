import type { GeoSessionFactor } from "@workspace/geo-domain";
import { and, eq } from "drizzle-orm";
import type { DbConnection } from "../db/db-connection";
import { account, user } from "../db/schema-auth";
import { geoOrgSettings, geoSessionFactors } from "../db/schema-geo";

const SECOND_FACTOR_PATHS: ReadonlySet<string> = new Set([
	"/two-factor/verify-totp",
	"/two-factor/verify-backup-code",
	"/two-factor/verify-otp",
]);
const SSO_CALLBACK_PATHS: ReadonlySet<string> = new Set(["/sso/callback/:providerId", "/sso/saml2/sp/acs/:providerId"]);

/**
 * What finishing this auth endpoint proves about a session. An SSO sign-in counts only
 * through a provider the deployment itself configured: any signed-in person can register
 * a provider over the API, and a social sign-in says nothing about a second factor.
 */
export function sessionFactorFor(
	path: string | undefined,
	providerId: string | undefined,
	deploymentSsoProviders: ReadonlySet<string>,
): GeoSessionFactor | null {
	if (!path) return null;
	if (SECOND_FACTOR_PATHS.has(path)) return "TWO_FACTOR";
	if (SSO_CALLBACK_PATHS.has(path) && providerId && deploymentSsoProviders.has(providerId)) return "SSO";
	return null;
}

export async function recordSessionFactor(
	db: DbConnection,
	input: { sessionId: string; userId: string; factor: GeoSessionFactor },
): Promise<void> {
	await db
		.insert(geoSessionFactors)
		.values(input)
		.onConflictDoUpdate({
			target: geoSessionFactors.sessionId,
			set: { factor: input.factor, verifiedAt: new Date() },
		});
}

export async function hasSessionFactor(db: DbConnection, sessionId: string): Promise<boolean> {
	const [row] = await db
		.select({ sessionId: geoSessionFactors.sessionId })
		.from(geoSessionFactors)
		.where(eq(geoSessionFactors.sessionId, sessionId))
		.limit(1);
	return Boolean(row);
}

export interface GeoSecondFactorState {
	adminMfaRequired: boolean;
	twoFactorEnabled: boolean;
	hasPassword: boolean;
	sessionFactor: GeoSessionFactor | null;
	/** Whether this session may perform what an organization reserves for a verified administrator. */
	satisfied: boolean;
}

/**
 * Judged on the session, not the account: an account with 2FA turned on proves nothing
 * about a session that signed in by a route that never asked for the code. The row must
 * be the same user's, and a 2FA row stops counting once 2FA is turned off.
 */
export async function loadGeoSecondFactorState(
	db: DbConnection,
	input: { organizationId: string; userId: string; sessionId: string | undefined },
): Promise<GeoSecondFactorState> {
	const [[settings], [person], [credential], [factorRow]] = await Promise.all([
		db
			.select({ required: geoOrgSettings.adminMfaRequired })
			.from(geoOrgSettings)
			.where(eq(geoOrgSettings.organizationId, input.organizationId))
			.limit(1),
		db.select({ twoFactorEnabled: user.twoFactorEnabled }).from(user).where(eq(user.id, input.userId)).limit(1),
		db
			.select({ id: account.id })
			.from(account)
			.where(and(eq(account.userId, input.userId), eq(account.providerId, "credential")))
			.limit(1),
		input.sessionId
			? db
					.select({ factor: geoSessionFactors.factor })
					.from(geoSessionFactors)
					.where(and(eq(geoSessionFactors.sessionId, input.sessionId), eq(geoSessionFactors.userId, input.userId)))
					.limit(1)
			: Promise.resolve([]),
	]);
	const adminMfaRequired = settings?.required ?? true;
	const twoFactorEnabled = person?.twoFactorEnabled === true;
	const sessionFactor =
		factorRow?.factor === "SSO" || (factorRow?.factor === "TWO_FACTOR" && twoFactorEnabled) ? factorRow.factor : null;
	return {
		adminMfaRequired,
		twoFactorEnabled,
		hasPassword: Boolean(credential),
		sessionFactor,
		satisfied: !adminMfaRequired || sessionFactor !== null,
	};
}
