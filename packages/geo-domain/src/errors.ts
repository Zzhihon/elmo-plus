export const GEO_ERROR_CODES = [
	"VALIDATION_ERROR",
	"TARGET_UNAVAILABLE",
	"RATE_LIMITED",
	"EVIDENCE_REQUIRED",
	"FORBIDDEN",
	"NOT_FOUND",
	"CONFLICT",
	"UNAUTHORIZED",
	"METHOD_NOT_ALLOWED",
	"INTERNAL_ERROR",
] as const;
export type GeoErrorCode = (typeof GEO_ERROR_CODES)[number];

const STATUS_BY_CODE: Record<GeoErrorCode, number> = {
	VALIDATION_ERROR: 400,
	UNAUTHORIZED: 401,
	FORBIDDEN: 403,
	NOT_FOUND: 404,
	METHOD_NOT_ALLOWED: 405,
	CONFLICT: 409,
	EVIDENCE_REQUIRED: 422,
	RATE_LIMITED: 429,
	INTERNAL_ERROR: 500,
	TARGET_UNAVAILABLE: 503,
};

export class GeoError extends Error {
	readonly code: GeoErrorCode;
	readonly status: number;

	constructor(code: GeoErrorCode, message: string, options?: { status?: number; cause?: unknown }) {
		super(message, options?.cause === undefined ? undefined : { cause: options.cause });
		this.name = "GeoError";
		this.code = code;
		this.status = options?.status ?? STATUS_BY_CODE[code];
	}
}
