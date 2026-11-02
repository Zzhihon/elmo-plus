import { GeoError } from "@workspace/geo-domain";
import { geoRequestId } from "./context";

/**
 * For the session-authenticated download and upload routes outside `/api/v1`. They are
 * not server functions, so they get the same-origin check here instead of from the
 * CSRF middleware.
 */
export function assertSameOrigin(request: Request): void {
	const origin = request.headers.get("Origin");
	const site = request.headers.get("Sec-Fetch-Site");
	const own = new URL(request.url).origin;
	if ((origin && origin !== own) || (site && site !== "same-origin" && site !== "none")) {
		throw new GeoError("FORBIDDEN", "拒绝跨站请求");
	}
	if (!origin && !site) throw new GeoError("FORBIDDEN", "缺少来源信息，拒绝请求");
}

export async function geoRouteResponse(request: Request, run: () => Promise<Response>): Promise<Response> {
	const requestId = geoRequestId(request);
	try {
		const response = await run();
		response.headers.set("X-Request-Id", requestId);
		return response;
	} catch (error) {
		if (error instanceof GeoError) {
			return Response.json(
				{ error: { code: error.code, message: error.message, request_id: requestId } },
				{ status: error.status, headers: { "X-Request-Id": requestId } },
			);
		}
		throw error;
	}
}

/** Uploaded evidence is shown inline only when it is an image; anything else downloads, and nothing may run scripts. */
export function evidenceHeaders(contentType: string | null, name: string): HeadersInit {
	const type = contentType ?? "application/octet-stream";
	const inline = type.startsWith("image/");
	return {
		"Content-Type": type,
		"Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${name.replace(/[^A-Za-z0-9._-]/g, "_")}"`,
		"Content-Security-Policy": "default-src 'none'; img-src 'self'; sandbox",
		"X-Content-Type-Options": "nosniff",
		"Cache-Control": "private, no-store",
	};
}
