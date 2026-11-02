import { type GeoPrincipal, principalCan } from "@workspace/geo-domain";
import { db } from "@workspace/lib/db/db";
import { user } from "@workspace/lib/db/schema";
import { inArray } from "drizzle-orm";
import { z } from "zod";

export const text = (max: number) => z.string().trim().max(max);
export const optionalText = (max: number) => text(max).nullish();

/** A calendar date or a full timestamp; a bare date means the end of that day in China time. */
export const validUntilSchema = z
	.string()
	.trim()
	.refine((value) => /^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isNaN(Date.parse(value)), "日期格式不正确")
	.nullish();

export function parseValidUntil(value: string | null | undefined): Date | null {
	if (!value) return null;
	if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return new Date(`${value}T23:59:59+08:00`);
	return new Date(value);
}

export function iso(value: Date | null | undefined): string | null {
	return value ? value.toISOString() : null;
}

export function canReadConfidential(principal: GeoPrincipal): boolean {
	return principalCan(principal, "knowledge.read_confidential");
}

export async function displayNames(ids: readonly (string | null | undefined)[]): Promise<Record<string, string>> {
	const userIds = [...new Set(ids.filter((id): id is string => Boolean(id)))].filter(
		(id) => !id.includes(":") && id !== "instance-admin",
	);
	if (userIds.length === 0) return {};
	const rows = await db.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, userIds));
	return Object.fromEntries(rows.map((row) => [row.id, row.name]));
}

export function nameOf(names: Record<string, string>, id: string | null | undefined): string | null {
	if (!id) return null;
	if (id.startsWith("system:")) return "系统";
	if (id.startsWith("apikey:")) return "API Key";
	return names[id] ?? id;
}

export interface Paging {
	limit: number;
	offset: number;
}

/** The shapes a claim value takes: text, a list, or a table. */
export type KnowledgeValue = string | string[] | string[][] | null;

export function knowledgeValue(value: unknown): KnowledgeValue {
	if (value === null || value === undefined) return null;
	if (typeof value === "string") return value;
	if (Array.isArray(value)) {
		if (value.every((entry) => typeof entry === "string")) return value as string[];
		if (value.every((entry) => Array.isArray(entry))) {
			return (value as unknown[][]).map((row) =>
				row.map((cell) => (typeof cell === "string" ? cell : JSON.stringify(cell))),
			);
		}
	}
	return JSON.stringify(value);
}

export type LocatorFields = Record<string, string | number | boolean | null>;

/** Keeps the flat fields of a stored locator, which is all any view shows. */
export function locatorFields(value: unknown): LocatorFields {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const fields: LocatorFields = {};
	for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
		if (entry === null || ["string", "number", "boolean"].includes(typeof entry)) {
			fields[key] = entry as string | number | boolean | null;
		}
	}
	return fields;
}
