import { isPublicAddress } from "./address";
import { type Resolver, type SafeFetchFailure, safeFetch, systemResolver } from "./safe-fetch";
import { checkUrl, normalizeHost, type UrlRefusal } from "./url-policy";

const DEFAULT_MAX_BYTES = 6 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 5 * 60_000;

/** `code` says why, for callers that classify failures; the message never reaches a stored field. */
export class GuardedFetchError extends Error {
	constructor(
		readonly code: SafeFetchFailure,
		message: string,
	) {
		super(message);
		this.name = "GuardedFetchError";
	}
}

export interface GuardedFetchOptions {
	resolve?: Resolver;
	/** Tests narrow these to reach a local server; production keeps public addresses and default ports only. */
	addressAllowed?: (address: string) => boolean;
	allowedPorts?: readonly number[];
	maxBytes?: number;
}

function hostnameOf(url: string): string | null {
	try {
		return normalizeHost(new URL(url).hostname);
	} catch {
		return null;
	}
}

function endpointPolicy(host: string, allowedPorts?: readonly number[]) {
	return { allowedHosts: [host], allowedPorts, allowSensitivePaths: true };
}

/** What can be judged from the URL alone, without touching the network. */
export function checkEndpointUrl(
	url: string,
	options: Pick<GuardedFetchOptions, "allowedPorts"> = {},
): { ok: true } | { ok: false; reason: UrlRefusal } {
	const decision = checkUrl(url, endpointPolicy(hostnameOf(url) ?? "", options.allowedPorts));
	return decision.ok ? { ok: true } : { ok: false, reason: decision.reason };
}

/**
 * The same judgement a request gets, for use before anything sensitive is read: the URL
 * passes, and every address the host resolves to right now is public.
 */
export async function checkEndpointReachable(
	url: string,
	options: Pick<GuardedFetchOptions, "resolve" | "addressAllowed" | "allowedPorts"> = {},
): Promise<{ ok: true } | { ok: false; code: SafeFetchFailure; detail: string }> {
	const decision = checkEndpointUrl(url, options);
	if (!decision.ok) return { ok: false, code: "URL_REFUSED", detail: `网址被拒绝：${decision.reason}` };
	const host = hostnameOf(url) ?? "";
	let addresses: { address: string }[];
	try {
		addresses = await (options.resolve ?? systemResolver)(host);
	} catch {
		return { ok: false, code: "DNS_FAILED", detail: `无法解析 ${host}` };
	}
	if (addresses.length === 0) return { ok: false, code: "DNS_FAILED", detail: `${host} 没有解析结果` };
	const allowed = options.addressAllowed ?? isPublicAddress;
	if (addresses.some((entry) => !allowed(entry.address))) {
		return { ok: false, code: "ADDRESS_BLOCKED", detail: `${host} 解析到非公网地址` };
	}
	return { ok: true };
}

function abortedBy<T>(work: Promise<T>, signal: AbortSignal | null | undefined): Promise<T> {
	if (!signal) return work;
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(signal.reason);
		if (signal.aborted) onAbort();
		signal.addEventListener("abort", onAbort, { once: true });
		work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
	});
}

/**
 * A `fetch` for calling a configured API endpoint, with the crawler's network rules: the
 * host resolves to public addresses only, the connection is pinned to the address that
 * was checked, nothing but the default port is reached, and a redirect is an error, so
 * neither a request nor its credential can be steered somewhere else.
 */
export function createGuardedFetch(options: GuardedFetchOptions = {}) {
	return async (input: string, init: RequestInit = {}): Promise<Response> => {
		const host = hostnameOf(input);
		if (!host) throw new GuardedFetchError("URL_REFUSED", "网址无效");
		const method = init.method === "POST" ? "POST" : "GET";
		const result = await abortedBy(
			safeFetch(input, {
				...endpointPolicy(host, options.allowedPorts),
				userAgent: "ElmoGeoSampling/1.0",
				maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
				timeoutMs: DEFAULT_TIMEOUT_MS,
				maxRedirects: 0,
				allowedMimeTypes: [],
				resolve: options.resolve,
				addressAllowed: options.addressAllowed,
				signal: init.signal ?? undefined,
				request: {
					method,
					headers: Object.fromEntries(new Headers(init.headers).entries()),
					body: typeof init.body === "string" ? init.body : undefined,
				},
			}),
			init.signal,
		);
		if (!result.ok) {
			if (init.signal?.aborted) throw init.signal.reason;
			throw new GuardedFetchError(result.code, result.detail);
		}
		const noBody = result.status === 204 || result.status === 205 || result.status === 304;
		return new Response(noBody ? null : Buffer.from(result.body), {
			status: result.status,
			headers: withoutEncoding(result.headers),
		});
	};
}

/** The body is already decoded and read in full, so these no longer describe it. */
function withoutEncoding(headers: Record<string, string>): Record<string, string> {
	const { "content-encoding": _encoding, "content-length": _length, "transfer-encoding": _transfer, ...rest } = headers;
	return rest;
}

export const guardedFetch = createGuardedFetch();
