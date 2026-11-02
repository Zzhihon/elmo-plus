import { createHmac, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertGeoPermission, type GeoPrincipal, principalCan } from "@workspace/geo-domain";
import { db } from "@workspace/lib/db/db";
import {
	apikey,
	geoApiKeyOwners,
	geoAuditLogs,
	geoKnowledgeAssets,
	geoOrgSettings,
	member,
	organization,
	session as sessionTable,
	user,
} from "@workspace/lib/db/schema";
import { loadGeoSecondFactorState, recordSessionFactor } from "@workspace/lib/geo/session-factor";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrganizationAuth } from "@/lib/auth/api-auth";
import { createGeoOrganization, expectGeoError } from "@/test/integration/geo-fixtures";

const authSession = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/helpers", () => ({ getAuthSession: authSession }));

const { requireGeoServerFnPrincipal, resolveGeoApiPrincipal, resolveGeoSessionPrincipal } = await import(
	"@/server/geo/context"
);
const { createDraft, transitionDraft } = await import("@/server/geo/drafts-core");
const { registerAssetClaim, reviewKnowledgeAsset, uploadKnowledgeAsset } = await import(
	"@/server/geo/knowledge-assets-core"
);
const { reviewClaim } = await import("@/server/geo/knowledge-core");

let objectRoot: string;

beforeAll(async () => {
	objectRoot = await mkdtemp(path.join(tmpdir(), "geo-identity-"));
	vi.stubEnv("GEO_OBJECT_STORE_URL", `file://${objectRoot}`);
	vi.stubEnv("GEO_WORKSPACE_ENABLED", "1");
	vi.stubEnv("DEPLOYMENT_MODE", "local");
});

afterAll(async () => {
	await rm(objectRoot, { recursive: true, force: true });
});

async function adminMember(organizationId: string) {
	const userId = `user-${randomUUID()}`;
	await db.insert(user).values({ id: userId, name: "管理员", email: `${userId}@example-electric.test` });
	await db.insert(member).values({
		id: `member-${randomUUID()}`,
		organizationId,
		userId,
		role: "owner",
		createdAt: new Date(),
	});
	return userId;
}

async function signedIn(userId: string) {
	const id = `session-${randomUUID()}`;
	await db.insert(sessionTable).values({
		id,
		userId,
		token: `token-${randomUUID()}`,
		expiresAt: new Date(Date.now() + 3_600_000),
		createdAt: new Date(),
		updatedAt: new Date(),
	});
	authSession.mockResolvedValue({ user: { id: userId }, session: { id } });
	return id;
}

describe("the administrator's second factor", () => {
	let organizationId: string;
	let userId: string;

	beforeEach(async () => {
		({ organizationId } = await createGeoOrganization());
		userId = await adminMember(organizationId);
	});

	it("is judged on this session, not on the account having 2FA turned on", async () => {
		await db.update(user).set({ twoFactorEnabled: true }).where(eq(user.id, userId));
		const sessionId = await signedIn(userId);
		await expectGeoError(requireGeoServerFnPrincipal(organizationId, "secret.manage"), "FORBIDDEN");

		await recordSessionFactor(db, { sessionId, userId, factor: "TWO_FACTOR" });
		const principal = await requireGeoServerFnPrincipal(organizationId, "secret.manage");
		expect(principal.actorId).toBe(userId);

		await signedIn(userId);
		await expectGeoError(requireGeoServerFnPrincipal(organizationId, "secret.manage"), "FORBIDDEN");
	});

	it.each(["brand.manage", "target.manage", "site.manage", "rbac.manage", "llm.approve", "settings.manage"] as const)(
		"guards %s the same way",
		async (permission) => {
			await signedIn(userId);
			await expectGeoError(requireGeoServerFnPrincipal(organizationId, permission), "FORBIDDEN");
		},
	);

	it("stops counting a second factor once it is turned off, but not an SSO sign-in", async () => {
		const sessionId = await signedIn(userId);
		await db.update(user).set({ twoFactorEnabled: false }).where(eq(user.id, userId));
		await recordSessionFactor(db, { sessionId, userId, factor: "TWO_FACTOR" });
		expect((await loadGeoSecondFactorState(db, { organizationId, userId, sessionId })).satisfied).toBe(false);

		await recordSessionFactor(db, { sessionId, userId, factor: "SSO" });
		expect((await loadGeoSecondFactorState(db, { organizationId, userId, sessionId })).satisfied).toBe(true);
	});

	it("does not exempt someone merely for having no password", async () => {
		const sessionId = await signedIn(userId);
		const state = await loadGeoSecondFactorState(db, { organizationId, userId, sessionId });
		expect(state.hasPassword).toBe(false);
		expect(state.satisfied).toBe(false);
	});

	it("follows the organization's dual-approved decision to relax the rule", async () => {
		await db.insert(geoOrgSettings).values({ organizationId, adminMfaRequired: false });
		await signedIn(userId);
		const principal = await resolveGeoSessionPrincipal(organizationId);
		expect(principalCan(principal, "secret.manage")).toBe(true);
	});
});

async function issuedKey(organizationId: string, ownerId: string): Promise<OrganizationAuth> {
	const keyId = `key-${randomUUID()}`;
	const now = new Date();
	await db.insert(apikey).values({ id: keyId, referenceId: organizationId, key: keyId, createdAt: now, updatedAt: now });
	await db.insert(geoApiKeyOwners).values({ keyId, organizationId, userId: ownerId });
	return {
		kind: "organization",
		keyId,
		name: "集成",
		organizationId,
		organizationName: "示例电气",
		scopes: new Set(["geo:read", "geo:write"]),
		brandIds: null,
		createdAt: now,
		lastUsedAt: null,
		expiresAt: null,
		rateLimit: { limit: 60, window: "minute" },
		rateLimitRemaining: 60,
	};
}

describe("what an API key writes", () => {
	let organizationId: string;
	let adminId: string;
	let key: GeoPrincipal;
	let selfReviewer: GeoPrincipal;
	let colleague: GeoPrincipal;
	let knowledgeReviewer: GeoPrincipal;
	let assetId: string;

	beforeAll(async () => {
		const org = await createGeoOrganization();
		organizationId = org.organizationId;
		adminId = await adminMember(organizationId);
		const auth = await issuedKey(organizationId, adminId);
		key = await resolveGeoApiPrincipal(auth, new Request("http://localhost/api/v1/geo/test"), `req-${randomUUID()}`);
		selfReviewer = {
			organizationId,
			actorId: adminId,
			actorKind: "user",
			roles: ["platform_admin", "tech_reviewer", "marketing_reviewer"],
			requestId: `req-${randomUUID()}`,
			secondFactorSatisfied: true,
		};
		colleague = await org.actor(["tech_reviewer"]);
		knowledgeReviewer = await org.actor(["knowledge_reviewer"]);

		const file = new File([new TextEncoder().encode(`%PDF-1.4\n% ${randomUUID()}\n%%EOF`)], "原件.pdf", {
			type: "application/pdf",
		});
		const { asset } = await uploadKnowledgeAsset(key, file, {
			title: "样本",
			assetType: "PRODUCT_SPEC",
			confidentiality: "PUBLIC",
			publicationScope: "PUBLIC",
		});
		assetId = asset.id;
		await db.update(geoKnowledgeAssets).set({ scanStatus: "CLEAN" }).where(eq(geoKnowledgeAssets.id, assetId));
		await reviewKnowledgeAsset(knowledgeReviewer, assetId, { decision: "APPROVE", note: "原件无误" });
	});

	const approve = { decision: "APPROVE" as const, basis: "与原件一致", publicationScope: "PUBLIC" as const };

	it("is recorded under the admin who issued the key, with the key in the audit trail", async () => {
		expect(key).toMatchObject({ actorId: adminId, actorKind: "api_key" });
		const audit = await db
			.select({ actorId: geoAuditLogs.actorId, actorKind: geoAuditLogs.actorKind, metadata: geoAuditLogs.metadata })
			.from(geoAuditLogs)
			.where(and(eq(geoAuditLogs.organizationId, organizationId), eq(geoAuditLogs.action, "knowledge.asset.upload")));
		expect(audit[0]).toMatchObject({ actorId: adminId, actorKind: "api_key" });
		expect((audit[0].metadata as { keyRef?: string }).keyRef).toBe(key.apiKeyId);
	});

	it("cannot be approved by that admin in a session, even holding reviewer roles", async () => {
		const { assertionId } = await registerAssetClaim(key, assetId, {
			entity: { kind: "PRODUCT", title: "样板开关" },
			claimType: "TECH_PARAMETER",
			fieldPath: "ratedVoltage",
			claimText: "样板开关额定电压 12kV",
			value: "12kV",
			locator: { page: 1 },
		});
		await expectGeoError(reviewClaim(selfReviewer, assertionId, approve), "FORBIDDEN");
		expect((await reviewClaim(colleague, assertionId, approve)).status).toBe("APPROVED");

		const draft = await createDraft(key, {
			kind: "FAQ",
			title: "选型问答",
			assertionIds: [assertionId],
			mode: "MANUAL",
			body: "样板开关额定电压 12kV[F1]。",
		});
		await transitionDraft(key, draft.id, { action: "SUBMIT" });
		await expectGeoError(transitionDraft(selfReviewer, draft.id, { action: "APPROVE_TECH" }), "FORBIDDEN");
	});

	it("stops working once the issuer is no longer an administrator of the organization", async () => {
		const orgB = await createGeoOrganization();
		const owner = await adminMember(orgB.organizationId);
		const auth = await issuedKey(orgB.organizationId, owner);
		await db
			.update(member)
			.set({ role: "member" })
			.where(and(eq(member.userId, owner), eq(member.organizationId, orgB.organizationId)));
		await expectGeoError(
			resolveGeoApiPrincipal(auth, new Request("http://localhost/api/v1/geo/test"), "req-demoted"),
			"FORBIDDEN",
		);
	});

	it("refuses a key that has GEO scopes but no recorded owner", async () => {
		const orgB = await createGeoOrganization();
		const now = new Date();
		const keyId = `key-${randomUUID()}`;
		await db
			.insert(apikey)
			.values({ id: keyId, referenceId: orgB.organizationId, key: keyId, createdAt: now, updatedAt: now });
		const auth = { ...(await issuedKey(orgB.organizationId, await adminMember(orgB.organizationId))), keyId };
		await expectGeoError(
			resolveGeoApiPrincipal(auth, new Request("http://localhost/api/v1/geo/test"), "req-ownerless"),
			"FORBIDDEN",
		);
	});

	it("leaves an instance admin key read-only, since nobody answers for it", async () => {
		const [org] = await db.select({ id: organization.id }).from(organization).limit(1);
		const instance = await resolveGeoApiPrincipal(
			{ kind: "admin", scopes: null, organizationId: null },
			new Request("http://localhost/api/v1/geo/test", { headers: { "X-Geo-Organization-Id": org.id } }),
			"req-instance",
		);
		expect(principalCan(instance, "observation.read")).toBe(true);
		for (const permission of ["content.write", "knowledge.write", "task.create", "sampling.run"] as const) {
			expect(() => assertGeoPermission(instance, permission)).toThrow();
		}
	});
});

function base32Decode(text: string): Buffer {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
	const bits = [...text.replace(/=+$/, "")]
		.map((char) => alphabet.indexOf(char).toString(2).padStart(5, "0"))
		.join("");
	const bytes = bits.match(/.{8}/g) ?? [];
	return Buffer.from(bytes.map((byte) => Number.parseInt(byte, 2)));
}

function totp(secret: Buffer): string {
	const counter = Buffer.alloc(8);
	counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
	const digest = createHmac("sha1", secret).update(counter).digest();
	const offset = digest[digest.length - 1] & 0xf;
	return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

describe("better-auth's second factor flow, end to end", () => {
	const ORIGIN = "http://localhost:3000";
	let auth: { handler: (request: Request) => Promise<Response> };

	beforeAll(async () => {
		vi.stubEnv("APP_URL", ORIGIN);
		vi.stubEnv("BETTER_AUTH_SECRET", "geo-identity-test-secret-geo-identity-test-secret");
		const { createAuth } = await import("@workspace/lib/auth/server");
		auth = createAuth();
	});

	function cookiesOf(response: Response, jar: Map<string, string>) {
		for (const cookie of response.headers.getSetCookie()) {
			const [pair] = cookie.split(";");
			const at = pair.indexOf("=");
			const name = pair.slice(0, at);
			const value = pair.slice(at + 1);
			if (value === "" || /max-age=0/i.test(cookie)) jar.delete(name);
			else jar.set(name, value);
		}
	}

	async function call(jar: Map<string, string>, route: string, body?: object) {
		const response = await auth.handler(
			new Request(`${ORIGIN}/api/auth${route}`, {
				method: body ? "POST" : "GET",
				headers: {
					"Content-Type": "application/json",
					Origin: ORIGIN,
					Cookie: [...jar].map(([name, value]) => `${name}=${value}`).join("; "),
				},
				body: body ? JSON.stringify(body) : undefined,
			}),
		);
		cookiesOf(response, jar);
		return { status: response.status, json: (await response.json().catch(() => null)) as Record<string, never> | null };
	}

	async function state(jar: Map<string, string>, organizationId: string, userId: string) {
		const fresh = new Map(
			[...jar].filter(([name]) => !name.endsWith("session_data")),
		);
		const { json } = await call(fresh, "/get-session?disableCookieCache=true");
		const sessionId = (json as unknown as { session: { id: string } }).session.id;
		return loadGeoSecondFactorState(db, { organizationId, userId, sessionId });
	}

	it("marks a session only when the code is right, and asks again for one that skipped the code", async () => {
		const { organizationId } = await createGeoOrganization();
		const email = `admin-${randomUUID()}@example-electric.test`;
		const password = "correct horse battery staple";
		const jar = new Map<string, string>();
		const signUp = await call(jar, "/sign-up/email", { email, password, name: "管理员" });
		expect(signUp.status).toBe(200);
		const userId = (signUp.json as unknown as { user: { id: string } }).user.id;

		expect((await state(jar, organizationId, userId)).satisfied).toBe(false);

		const enrolled = await call(jar, "/two-factor/enable", { password });
		expect(enrolled.status).toBe(200);
		const secret = new URL((enrolled.json as unknown as { totpURI: string }).totpURI).searchParams.get("secret");
		if (!secret) throw new Error("no TOTP secret");
		const raw = base32Decode(secret);

		const wrong = await call(jar, "/two-factor/verify-totp", { code: "000000" });
		expect(wrong.status).toBe(401);
		expect((await state(jar, organizationId, userId)).satisfied).toBe(false);

		expect((await call(jar, "/two-factor/verify-totp", { code: totp(raw) })).status).toBe(200);
		const enrolledState = await state(jar, organizationId, userId);
		expect(enrolledState).toMatchObject({ twoFactorEnabled: true, sessionFactor: "TWO_FACTOR", satisfied: true });

		const signIn = new Map<string, string>();
		const challenged = await call(signIn, "/sign-in/email", { email, password });
		expect((challenged.json as unknown as { twoFactorRedirect: boolean }).twoFactorRedirect).toBe(true);
		const verified = await call(signIn, "/two-factor/verify-totp", { code: totp(raw), trustDevice: true });
		expect(verified.status).toBe(200);
		expect((await state(signIn, organizationId, userId)).satisfied).toBe(true);

		// A trusted device skips the code at sign-in, so this session has proved nothing yet.
		const trusted = new Map([...signIn].filter(([name]) => name.includes("trust_device")));
		const again = await call(trusted, "/sign-in/email", { email, password });
		expect((again.json as unknown as { twoFactorRedirect?: boolean }).twoFactorRedirect).toBeUndefined();
		expect((await state(trusted, organizationId, userId)).satisfied).toBe(false);
		expect((await call(trusted, "/two-factor/disable", { password })).status).toBe(403);

		expect((await call(trusted, "/two-factor/verify-totp", { code: totp(raw) })).status).toBe(200);
		expect((await state(trusted, organizationId, userId)).satisfied).toBe(true);
		expect((await call(trusted, "/two-factor/disable", { password })).status).toBe(200);
	});
});
