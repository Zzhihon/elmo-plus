import { randomUUID } from "node:crypto";
import type { GeoPrincipal, GeoRole } from "@workspace/geo-domain";
import { db } from "@workspace/lib/db/db";
import { member, organization, user } from "@workspace/lib/db/schema";

export interface GeoTestOrganization {
	organizationId: string;
	/** A principal for a fresh member of the organization holding exactly these roles. */
	actor: (roles: GeoRole[], name?: string) => Promise<GeoPrincipal>;
}

export async function createGeoOrganization(): Promise<GeoTestOrganization> {
	const organizationId = `org-${randomUUID()}`;
	await db
		.insert(organization)
		.values({ id: organizationId, name: "示例电气", slug: organizationId, createdAt: new Date() });
	return {
		organizationId,
		actor: async (roles, name = "测试成员") => {
			const userId = `user-${randomUUID()}`;
			await db.insert(user).values({ id: userId, name, email: `${userId}@example-electric.test` });
			await db.insert(member).values({
				id: `member-${randomUUID()}`,
				organizationId,
				userId,
				role: "member",
				createdAt: new Date(),
			});
			return { organizationId, actorId: userId, actorKind: "user", roles, requestId: `req-${randomUUID()}` };
		},
	};
}

export async function expectGeoError(promise: Promise<unknown>, code: string): Promise<string> {
	try {
		await promise;
	} catch (error) {
		const { code: actual, message } = error as { code?: string; message: string };
		if (actual !== code) throw new Error(`expected ${code}, got ${actual ?? "no code"}: ${message}`);
		return message;
	}
	throw new Error(`expected ${code}, but the call succeeded`);
}
