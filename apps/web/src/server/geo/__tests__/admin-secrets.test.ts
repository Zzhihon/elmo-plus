import { randomBytes } from "node:crypto";
import { GeoError, type GeoPrincipal } from "@workspace/geo-domain";
import { secrets } from "@workspace/lib/db/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Everything written through the fake transaction, so a test can search it for the secret. */
const writes = vi.hoisted(() => [] as { table: unknown; values: unknown }[]);

vi.mock("@workspace/lib/db/db", () => {
	const tx = {
		select: () => ({ from: () => ({ where: () => ({ limit: async () => [], orderBy: async () => [] }) }) }),
		insert: (table: unknown) => ({
			values: (values: unknown) => {
				writes.push({ table, values });
				return { onConflictDoUpdate: async () => undefined, returning: async () => [{ id: "audit-1" }] };
			},
		}),
	};
	return { db: { ...tx, transaction: async (run: (t: typeof tx) => unknown) => run(tx) } };
});
vi.mock("@/lib/boss-client", () => ({ getBoss: async () => ({ getQueues: async () => [] }) }));

const { listCredentials, putCredential, removeCredential } = await import("../admin-core");

const SECRET = "sk-geo-test-9f3c1b7e5d2a4c6b8e0f";

function principal(overrides: Partial<GeoPrincipal>): GeoPrincipal {
	return { organizationId: "org-1", actorId: "user-1", actorKind: "user", roles: [], requestId: "req-1", ...overrides };
}

const admin = principal({ roles: ["platform_admin"] });
const viewer = principal({ actorId: "user-2", roles: ["viewer"] });
const operatorKey = principal({
	actorId: "apikey:k1",
	actorKind: "api_key",
	roles: ["viewer", "geo_operator"],
	scopes: ["read", "write"],
});

let logged: string[] = [];

beforeEach(() => {
	writes.length = 0;
	logged = [];
	vi.stubEnv("ELMO_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
	for (const level of ["log", "info", "warn", "error", "debug"] as const) {
		vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
			logged.push(args.map(String).join(" "));
		});
	}
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

describe("platform credentials (UAT-12)", () => {
	it.each([
		["an ordinary member", viewer],
		["an operator's API key", operatorKey],
	])("refuses %s and writes nothing", async (_label, caller) => {
		await expect(listCredentials(caller)).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(putCredential(caller, { ref: "DOUBAO_API_KEY", value: SECRET })).rejects.toBeInstanceOf(GeoError);
		await expect(removeCredential(caller, "DOUBAO_API_KEY")).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(writes).toHaveLength(0);
	});

	it("stores only ciphertext and keeps the value out of the response, the audit row and the logs", async () => {
		const result = await putCredential(admin, { ref: "DOUBAO_API_KEY", value: SECRET });

		expect(JSON.stringify(result)).not.toContain(SECRET);
		const stored = writes.find((write) => write.table === secrets);
		expect(stored).toBeDefined();
		expect(JSON.stringify(stored?.values)).not.toContain(SECRET);

		const audit = writes.filter((write) => write.table !== secrets);
		expect(audit).toHaveLength(1);
		expect(JSON.stringify(audit[0].values)).not.toContain(SECRET);
		expect(audit[0].values).toMatchObject({ action: "secret.create", entityId: "DOUBAO_API_KEY" });

		expect(logged.join("\n")).not.toContain(SECRET);
	});
});
