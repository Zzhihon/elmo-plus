/** What a jsonb column holds, typed so server functions can send it to the client. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export function asJson(value: unknown): JsonValue {
	return (value ?? null) as JsonValue;
}

export function asJsonObject(value: unknown): JsonObject {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}
