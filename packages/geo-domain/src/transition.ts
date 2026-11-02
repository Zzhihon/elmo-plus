import type { GeoErrorCode } from "./errors";
import { GeoError } from "./errors";
import { can, type GeoPermission, type GeoRole } from "./permissions";

export type GeoTransitionFailureCode = Extract<
	GeoErrorCode,
	"CONFLICT" | "FORBIDDEN" | "VALIDATION_ERROR" | "EVIDENCE_REQUIRED"
>;

export type GeoTransitionResult<S> =
	| { ok: true; to: S }
	| { ok: false; code: GeoTransitionFailureCode; message: string };

export type GeoTransitionActor = { kind: "principal"; id: string; roles: readonly GeoRole[] } | { kind: "system" };

export function fail<S>(code: GeoTransitionFailureCode, message: string): GeoTransitionResult<S> {
	return { ok: false, code, message };
}

export function actorHolds(actor: GeoTransitionActor, permission: GeoPermission): boolean {
	return actor.kind === "principal" && can(actor.roles, permission);
}

export function hasText(value: string | null | undefined): boolean {
	return typeof value === "string" && value.trim().length > 0;
}

export function assertGeoTransition<S>(result: GeoTransitionResult<S>): S {
	if (!result.ok) throw new GeoError(result.code, result.message);
	return result.to;
}
