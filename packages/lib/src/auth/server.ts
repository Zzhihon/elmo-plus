import { apiKey } from "@better-auth/api-key";
import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { mcp } from "@better-auth/mcp";
import { oauthProviderAuthServerMetadata } from "@better-auth/oauth-provider";
import { type SSOOptions, sso } from "@better-auth/sso";
import { API_KEY_RATE_LIMIT_PER_MINUTE, MCP_PATH } from "@workspace/config/constants";
import { isGeoWorkspaceEnabled } from "@workspace/config/geo";
import { type BetterAuthOptions, type BetterAuthPlugin, betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import {
	createDpopReplayStore,
	enforceDpopBinding,
	parseAccessTokenAuthorization,
	verifyJwsAccessToken,
} from "better-auth/oauth2";
import { admin, customSession, jwt, organization, twoFactor } from "better-auth/plugins";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import type { JWTPayload } from "jose";
import { db } from "../db/db";
import * as schema from "../db/schema";
import { auditGeoMembershipChange } from "../geo/membership-audit";
import { hasSessionFactor, recordSessionFactor, sessionFactorFor } from "../geo/session-factor";
import { nativeClientRegistrationDefault } from "./native-client-registration";
import { ac, adminRole, memberRole, ownerRole, userRole } from "./permissions";

export interface CreateAuthOptions {
	databaseHooks?: BetterAuthOptions["databaseHooks"];
	sso?: SSOOptions;
	trustedOrigins?: string[];
	emailAndPasswordEnabled?: boolean;
	minPasswordLength?: number;
	disableSignUp?: boolean;
	requireEmailVerification?: boolean;
	emailVerification?: BetterAuthOptions["emailVerification"];
	sendResetPassword?: NonNullable<BetterAuthOptions["emailAndPassword"]>["sendResetPassword"];
	socialProviders?: BetterAuthOptions["socialProviders"];
	organizationOptions?: Parameters<typeof organization>[0];
	/** A plugin adding schema must also go in scripts/generate-auth-schema.sh. */
	extraPlugins?: BetterAuthPlugin[];
}

export const MCP_AUTHORIZE_PAGE = "/auth/authorize";

const LOGIN_PAGE = "/auth/login";

/** Checked here so the failure names APP_URL rather than the plugin's TypeError. */
function mcpResource(origin: string): string {
	const { protocol, hostname } = new URL(origin);
	const octets = hostname.split(".");
	const isLoopbackIpv4 =
		octets.length === 4 && octets[0] === "127" && octets.every((octet) => /^\d+$/.test(octet) && Number(octet) <= 255);
	if (protocol !== "https:" && !(hostname === "localhost" || hostname === "[::1]" || isLoopbackIpv4)) {
		throw new Error(
			`APP_URL must be an HTTPS URL (or localhost) to serve MCP: an access token is bound to ${origin}${MCP_PATH}, and MCP clients refuse a resource identifier that isn't. Got ${origin}.`,
		);
	}
	return `${origin}${MCP_PATH}`;
}

/**
 * Without an RFC 8707 `resource` the plugin issues an opaque token instead of a
 * JWT. There is one resource here, so filling it in grants nothing the client
 * was not already asking for.
 */
function mcpResourceDefault(resource: string) {
	return {
		id: "mcp-resource-default",
		version: "1.0",
		hooks: {
			before: [
				{
					matcher: (ctx: { path?: string }) => ctx.path === "/oauth2/authorize",
					// A before hook gets a copy of the context; only what it returns is used.
					handler: createAuthMiddleware(async (ctx) => {
						const body = ctx.body as Record<string, unknown> | undefined;
						if (ctx.query?.resource || body?.resource) return;
						return {
							context: {
								query: { ...ctx.query, resource },
								...(body && { body: { ...body, resource } }),
							},
						};
					}),
				},
			],
		},
	} satisfies BetterAuthPlugin;
}

/**
 * Notes which sessions finished a second factor or came through a deployment's own SSO
 * provider, the fact GEO's administrative permissions check. A failure to note it leaves
 * the session unverified, and verifying again is one code away, so it does not fail the sign-in.
 */
function geoSessionFactorPlugin(deploymentSsoProviders: ReadonlySet<string>) {
	return {
		id: "geo-session-factor",
		version: "1.0",
		hooks: {
			before: [
				{
					matcher: (ctx) => ctx.path === "/two-factor/disable",
					// Otherwise a session that never proved the factor could remove it and enroll its own.
					handler: createAuthMiddleware(async (ctx) => {
						const current = await getSessionFromCtx(ctx);
						if (current && !(await hasSessionFactor(db, current.session.id))) {
							throw new APIError("FORBIDDEN", { message: "请先在本次登录中完成两步验证，再关闭两步验证" });
						}
					}),
				},
			],
			after: [
				{
					matcher: (ctx) => sessionFactorFor(ctx.path, ctx.params?.providerId, deploymentSsoProviders) !== null,
					handler: createAuthMiddleware(async (ctx) => {
						const factor = sessionFactorFor(ctx.path, ctx.params?.providerId, deploymentSsoProviders);
						if (!factor) return;
						// A rejected code surfaces here as an error; a finished SSO login redirects, which is one too.
						if (factor === "TWO_FACTOR" && ctx.context.returned instanceof APIError) return;
						const signedIn =
							factor === "SSO" ? ctx.context.newSession : (ctx.context.newSession ?? ctx.context.session);
						if (!signedIn?.session) return;
						await recordSessionFactor(db, {
							sessionId: signedIn.session.id,
							userId: signedIn.user.id,
							factor,
						}).catch((error) => console.error("[geo-auth] could not record the session factor", error));
					}),
				},
			],
		},
	} satisfies BetterAuthPlugin;
}

type OrganizationHooks = NonNullable<NonNullable<CreateAuthOptions["organizationOptions"]>["organizationHooks"]>;

/** Keeps the deployment's own hooks and, with GEO on, audits who gains or loses administrator standing. */
function withGeoMembershipAudit(hooks: OrganizationHooks | undefined): OrganizationHooks | undefined {
	if (!isGeoWorkspaceEnabled()) return hooks;
	const audit = (change: Parameters<typeof auditGeoMembershipChange>[1]) =>
		auditGeoMembershipChange(db, change).catch((error) =>
			console.error("[geo-auth] could not audit a membership change", error),
		);
	return {
		...hooks,
		afterAddMember: async (data) => {
			await hooks?.afterAddMember?.(data);
			await audit({
				organizationId: data.organization.id,
				userId: data.user.id,
				previousRole: null,
				role: data.member.role,
			});
		},
		afterAcceptInvitation: async (data) => {
			await hooks?.afterAcceptInvitation?.(data);
			await audit({
				organizationId: data.organization.id,
				userId: data.user.id,
				previousRole: null,
				role: data.member.role,
			});
		},
		afterUpdateMemberRole: async (data) => {
			await hooks?.afterUpdateMemberRole?.(data);
			await audit({
				organizationId: data.organization.id,
				userId: data.user.id,
				previousRole: data.previousRole,
				role: data.member.role,
			});
		},
		afterRemoveMember: async (data) => {
			await hooks?.afterRemoveMember?.(data);
			await audit({
				organizationId: data.organization.id,
				userId: data.user.id,
				previousRole: data.member.role,
				role: null,
			});
		},
	};
}

/** GEO administrators must hold a second factor; outside GEO nothing asks for one. */
function geoAuthPlugins(sso: CreateAuthOptions["sso"]): BetterAuthPlugin[] {
	if (!isGeoWorkspaceEnabled()) return [];
	const deploymentSsoProviders = new Set((sso?.defaultSSO ?? []).map((provider) => provider.providerId));
	return [
		// Passwordless: someone who signs in only through a social provider still has to be able to enroll.
		twoFactor({ issuer: process.env.VITE_APP_NAME || "Elmo", allowPasswordless: true }),
		geoSessionFactorPlugin(deploymentSsoProviders),
	];
}

export function createAuth(options?: CreateAuthOptions) {
	const appUrl = process.env.APP_URL || process.env.VITE_APP_URL;
	if (!appUrl) {
		throw new Error("APP_URL or VITE_APP_URL must be set for Better Auth");
	}

	const localOrigin =
		process.env.NODE_ENV !== "production" ? `http://localhost:${process.env.PORT ?? "3000"}` : undefined;
	const baseURL = localOrigin ?? appUrl;

	const origin = baseURL.replace(/\/$/, "");
	const resource = mcpResource(origin);

	const origins = options?.trustedOrigins ?? [];
	if (!origins.includes(appUrl)) {
		origins.push(appUrl);
	}
	if (localOrigin && !origins.includes(localOrigin)) {
		origins.push(localOrigin);
	}

	return betterAuth({
		database: drizzleAdapter(db, {
			provider: "pg",
			schema,
		}),
		secret: process.env.BETTER_AUTH_SECRET,
		baseURL,
		basePath: "/api/auth",
		trustedOrigins: origins,

		// The default memory store is per-instance and resets on cold starts.
		rateLimit: { storage: "database" },

		emailAndPassword: {
			enabled: options?.emailAndPasswordEnabled !== false,
			requireEmailVerification: options?.requireEmailVerification === true,
			...(options?.minPasswordLength !== undefined && {
				minPasswordLength: options.minPasswordLength,
			}),
			...(options?.disableSignUp === true && { disableSignUp: true }),
			...(options?.sendResetPassword && { sendResetPassword: options.sendResetPassword }),
		},
		...(options?.emailVerification && { emailVerification: options.emailVerification }),
		...(options?.socialProviders && { socialProviders: options.socialProviders }),

		user: {
			additionalFields: {
				hasReportGeneratorAccess: {
					type: "boolean",
					required: false,
					defaultValue: false,
					input: false,
				},
			},
		},

		session: {
			cookieCache: {
				enabled: true,
				maxAge: 5 * 60,
				strategy: "compact",
			},
		},

		databaseHooks: options?.databaseHooks,

		plugins: [
			organization({
				ac,
				roles: { owner: ownerRole, admin: ownerRole, member: memberRole },
				...options?.organizationOptions,
				organizationHooks: withGeoMembershipAudit(options?.organizationOptions?.organizationHooks),
			}),
			// `permissions` is server-only to the plugin, so scopes cannot be set
			// from a browser.
			apiKey({
				references: "organization",
				defaultPrefix: "elmo_",
				enableMetadata: true,
				// Stamped onto each key at creation, so raising it does nothing for
				// keys already issued.
				rateLimit: { enabled: true, timeWindow: 60_000, maxRequests: API_KEY_RATE_LIMIT_PER_MINUTE },
			}),
			admin({
				ac,
				roles: {
					admin: adminRole,
					user: userRole,
				},
			}),
			// Required by mcp(): a public client has no secret to sign tokens with.
			// The header would otherwise sign a JWT on every session read.
			jwt({ disableSettingJwtHeader: true }),
			mcpResourceDefault(resource),
			nativeClientRegistrationDefault(),
			cimd({ fetchClientMetadataResource, metadataProfile: "mcp-2026-07-28" }),
			mcp({
				loginPage: LOGIN_PAGE,
				consentPage: MCP_AUTHORIZE_PAGE,
				resource,
				// A client that has never met this instance has no secret to register
				// with; PKCE stands in for one.
				allowDynamicClientRegistration: true,
				allowUnauthenticatedClientRegistration: true,
			}),
			sso(options?.sso),
			...geoAuthPlugins(options?.sso),
			...(options?.extraPlugins ?? []),
			// Runs on every session read, including cookie-cache hits. Keep it free
			// of queries.
			customSession(async ({ user, session }) => {
				const u = user as Record<string, unknown>;
				return {
					user: {
						...user,
						role: (u.role as string) ?? "user",
						hasReportGeneratorAccess: u.hasReportGeneratorAccess === true,
					},
					session,
				};
			}),
			tanstackStartCookies(),
		],
	});
}

export type Auth = ReturnType<typeof createAuth>;

/** Cache identity, so the key set is read once every few minutes. */
const jwksCacheKey = {};

/**
 * `verifyAccessTokenRequest`, but reading the keys through `auth.api`: it only
 * fetches them from `jwks_uri`, which names the address clients reach the app
 * on, not one the app can reach itself.
 */
export async function verifyMcpAccessToken(auth: Auth, request: Request): Promise<JWTPayload> {
	const authorization = parseAccessTokenAuthorization(request.headers.get("authorization"));
	if (!authorization?.token || authorization.scheme === "Unknown") {
		throw new Error("no Bearer or DPoP access token");
	}

	const { baseURL, internalAdapter } = await auth.$context;
	const origin = new URL(baseURL).origin;
	const payload = await verifyJwsAccessToken(authorization.token, {
		jwksFetch: () => auth.api.getJwks(),
		jwksCacheKey,
		verifyOptions: { issuer: baseURL, audience: `${origin}${MCP_PATH}` },
	});

	// A no-op for a token carrying no `cnf`. The URL is rebuilt on the configured
	// origin because that is what the client signed into `htu`; the request's own
	// can be an address behind a proxy.
	await enforceDpopBinding({
		payload,
		authorization,
		proofJwt: request.headers.get("dpop"),
		method: request.method,
		url: new URL(new URL(request.url).pathname, origin).toString(),
		// Database-backed, so a replay against another instance is caught.
		replayStore: createDpopReplayStore(internalAdapter),
	});
	return payload;
}

export { MCP_PATH, oauthProviderAuthServerMetadata };
