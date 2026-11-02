import { createHash } from "node:crypto";
import type { GeoPrincipal } from "@workspace/geo-domain";
import type { DbConnection } from "../db/db-connection";
import { geoAuditLogs } from "../db/schema-geo";

const SECRET_KEY = /secret|password|passwd|token|credential|api[-_]?key|authorization|cookie/i;
const REDACTED = "[REDACTED]";

function canonicalize(value: unknown): unknown {
	if (value === null || typeof value !== "object") {
		return typeof value === "bigint" ? value.toString() : value;
	}
	if (value instanceof Date) return value.toISOString();
	if (Array.isArray(value)) return value.map(canonicalize);
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, entry]) => entry !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([key, entry]) => [key, canonicalize(entry)]);
	return Object.fromEntries(entries);
}

/** Independent of key order, so a row read back from the database hashes as it did when written. */
export function geoAuditHash(value: unknown): string | null {
	if (value === undefined || value === null) return null;
	return createHash("sha256")
		.update(JSON.stringify(canonicalize(value)))
		.digest("hex");
}

function redact(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(redact);
	if (value === null || typeof value !== "object" || value instanceof Date) return value;
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
			key,
			SECRET_KEY.test(key) ? REDACTED : redact(entry),
		]),
	);
}

export interface GeoAuditEntry {
	principal: Pick<GeoPrincipal, "organizationId" | "actorId" | "actorKind" | "requestId">;
	action: string;
	entityType: string;
	entityId: string;
	before?: unknown;
	after?: unknown;
	metadata?: Record<string, unknown>;
}

/** Pass the transaction doing the business write: a change and its audit row commit or fail together. */
export async function writeGeoAudit(tx: DbConnection, entry: GeoAuditEntry): Promise<{ id: string }> {
	const { principal } = entry;
	const [row] = await tx
		.insert(geoAuditLogs)
		.values({
			organizationId: principal.organizationId,
			actorId: principal.actorId,
			actorKind: principal.actorKind,
			action: entry.action,
			entityType: entry.entityType,
			entityId: entry.entityId,
			beforeHash: geoAuditHash(entry.before),
			afterHash: geoAuditHash(entry.after),
			metadata: entry.metadata === undefined ? null : redact(entry.metadata),
			requestId: principal.requestId,
		})
		.returning({ id: geoAuditLogs.id });
	return { id: row.id };
}
