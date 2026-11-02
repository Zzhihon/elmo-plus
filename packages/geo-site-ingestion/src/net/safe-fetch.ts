import { lookup as dnsLookup } from "node:dns/promises";
import http, { type IncomingMessage } from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";
import { pipeline } from "node:stream";
import zlib from "node:zlib";
import { isPublicAddress } from "./address";
import { checkUrl, redirectPolicyOf, type UrlRefusal } from "./url-policy";

export interface ResolvedAddress {
	address: string;
	family: 4 | 6;
}

export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

export const systemResolver: Resolver = async (hostname) => {
	const results = await dnsLookup(hostname, { all: true, verbatim: true });
	return results.map((result) => ({ address: result.address, family: result.family === 6 ? 6 : 4 }));
};

export interface SafeFetchOptions {
	/** Every hop, including the first, must stay on these hosts. */
	allowedHosts: readonly string[];
	userAgent: string;
	accept?: string;
	maxBytes: number;
	/** Wall-clock limit for the whole exchange, redirects and body included. */
	timeoutMs: number;
	maxRedirects?: number;
	/** `type/subtype`, lower case. A 2xx answer of any other type is refused unread. */
	allowedMimeTypes: readonly string[];
	resolve?: Resolver;
	/** Tests narrow this to reach a local server; production keeps public addresses only. */
	addressAllowed?: (address: string) => boolean;
	signal?: AbortSignal;
}

export interface RedirectHop {
	from: string;
	to: string;
	status: number;
}

export type SafeFetchFailure =
	| "URL_REFUSED"
	| "DNS_FAILED"
	| "ADDRESS_BLOCKED"
	| "REDIRECT_BLOCKED"
	| "TOO_MANY_REDIRECTS"
	| "TIMEOUT"
	| "TOO_LARGE"
	| "MIME_REJECTED"
	| "NETWORK";

export interface SafeFetchSuccess {
	ok: true;
	url: string;
	finalUrl: string;
	status: number;
	headers: Record<string, string>;
	mimeType: string | null;
	charset: string | null;
	body: Uint8Array;
	redirects: RedirectHop[];
	durationMs: number;
	address: string;
}

export interface SafeFetchError {
	ok: false;
	code: SafeFetchFailure;
	detail: string;
	url: string;
	finalUrl: string;
	status?: number;
	redirects: RedirectHop[];
	durationMs: number;
	/** For a refused hop: where it tried to go and why it was refused. */
	blockedTarget?: string;
	blockedReason?: UrlRefusal | "PRIVATE_ADDRESS";
}

export type SafeFetchResult = SafeFetchSuccess | SafeFetchError;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

class FetchAbort extends Error {
	constructor(
		readonly code: SafeFetchFailure,
		message: string,
		readonly status?: number,
	) {
		super(message);
	}
}

export function parseContentType(header: string | undefined): { mimeType: string | null; charset: string | null } {
	if (!header) return { mimeType: null, charset: null };
	const [type, ...params] = header.split(";");
	const mimeType = type.trim().toLowerCase() || null;
	const charsetParam = params.map((param) => param.trim()).find((param) => param.toLowerCase().startsWith("charset="));
	const charset = charsetParam ? charsetParam.slice(8).trim().replace(/^"|"$/g, "").toLowerCase() : null;
	return { mimeType, charset };
}

/** The resolved addresses, all of which must be public; one private answer fails the whole host. */
async function resolvePinned(
	hostname: string,
	resolve: Resolver,
	addressAllowed: (address: string) => boolean,
): Promise<ResolvedAddress> {
	let addresses: ResolvedAddress[];
	try {
		addresses = await resolve(hostname);
	} catch (error) {
		throw new FetchAbort("DNS_FAILED", `无法解析 ${hostname}：${(error as Error).message}`);
	}
	if (addresses.length === 0) throw new FetchAbort("DNS_FAILED", `${hostname} 没有解析结果`);
	const refused = addresses.find((entry) => !addressAllowed(entry.address));
	if (refused) throw new FetchAbort("ADDRESS_BLOCKED", `${hostname} 解析到非公网地址 ${refused.address}`);
	return addresses[0];
}

/** Hands the socket the address already checked, so a second DNS answer cannot redirect it. */
function pinnedLookup(pinned: ResolvedAddress): LookupFunction {
	return ((_hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
		if (options?.all) callback(null, [{ address: pinned.address, family: pinned.family }]);
		else callback(null, pinned.address, pinned.family);
	}) as LookupFunction;
}

function decoded(response: IncomingMessage): NodeJS.ReadableStream {
	const encoding = (response.headers["content-encoding"] ?? "").toLowerCase().trim();
	const decoder =
		encoding === "gzip" || encoding === "x-gzip"
			? zlib.createGunzip()
			: encoding === "deflate"
				? zlib.createInflate()
				: encoding === "br"
					? zlib.createBrotliDecompress()
					: null;
	if (!decoder) return response;
	pipeline(response, decoder, () => {});
	return decoder;
}

interface HopResult {
	response: IncomingMessage;
	address: string;
}

function request(
	url: URL,
	pinned: ResolvedAddress,
	options: SafeFetchOptions,
	register: (destroy: (error: Error) => void) => void,
): Promise<HopResult> {
	const transport = url.protocol === "https:" ? https : http;
	return new Promise((resolve, reject) => {
		const req = transport.request(
			url,
			{
				method: "GET",
				lookup: pinnedLookup(pinned),
				agent: false,
				headers: {
					"User-Agent": options.userAgent,
					Accept: options.accept ?? "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
					"Accept-Encoding": "gzip, deflate, br",
					"Accept-Language": "zh-CN,zh;q=0.9,en;q=0.5",
					Connection: "close",
				},
			},
			(response) => resolve({ response, address: pinned.address }),
		);
		register((error) => req.destroy(error));
		req.on("error", reject);
		req.end();
	});
}

function readBody(response: IncomingMessage, maxBytes: number, register: (destroy: (error: Error) => void) => void) {
	return new Promise<Uint8Array>((resolve, reject) => {
		const declared = Number(response.headers["content-length"]);
		if (Number.isFinite(declared) && declared > maxBytes) {
			response.destroy();
			reject(new FetchAbort("TOO_LARGE", `声明大小 ${declared} 字节超过上限 ${maxBytes}`, response.statusCode));
			return;
		}
		const stream = decoded(response);
		const chunks: Buffer[] = [];
		let size = 0;
		register((error) => {
			response.destroy(error);
			reject(error);
		});
		stream.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > maxBytes) {
				response.destroy();
				reject(new FetchAbort("TOO_LARGE", `内容超过上限 ${maxBytes} 字节`, response.statusCode));
				return;
			}
			chunks.push(chunk);
		});
		stream.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
		stream.on("error", (error) => reject(error));
	});
}

/**
 * The only way the crawler talks to the network. Every hop is checked against the
 * host allowlist, resolved once, refused if any answer is not a public address,
 * and connected to that exact address. Size, time and type limits are enforced
 * while reading, so an oversized or endless answer is cut off rather than buffered.
 */
export async function safeFetch(input: string, options: SafeFetchOptions): Promise<SafeFetchResult> {
	const started = Date.now();
	const redirects: RedirectHop[] = [];
	const resolve = options.resolve ?? systemResolver;
	const addressAllowed = options.addressAllowed ?? isPublicAddress;
	const maxRedirects = options.maxRedirects ?? 5;
	let current = input;
	let destroyActive: ((error: Error) => void) | null = null;
	const register = (destroy: (error: Error) => void) => {
		destroyActive = destroy;
	};
	const timeout = new FetchAbort("TIMEOUT", `超过 ${options.timeoutMs} 毫秒未完成`);
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		destroyActive?.(timeout);
	}, options.timeoutMs);
	const onAbort = () => destroyActive?.(new FetchAbort("NETWORK", "已取消"));
	options.signal?.addEventListener("abort", onAbort, { once: true });

	const fail = (code: SafeFetchFailure, detail: string, extra: Partial<SafeFetchError> = {}): SafeFetchError => ({
		ok: false,
		code,
		detail,
		url: input,
		finalUrl: current,
		redirects,
		durationMs: Date.now() - started,
		...extra,
	});

	try {
		const first = checkUrl(current, redirectPolicyOf(options.allowedHosts));
		if (!first.ok) return fail("URL_REFUSED", `网址被拒绝：${first.reason}`, { blockedReason: first.reason });

		for (let hop = 0; ; hop++) {
			const url = new URL(current);
			const pinned = await resolvePinned(url.hostname, resolve, addressAllowed);
			if (timedOut) throw timeout;
			const { response, address } = await request(url, pinned, options, register);
			const status = response.statusCode ?? 0;

			if (REDIRECT_STATUSES.has(status) && response.headers.location) {
				response.resume();
				const target = new URL(response.headers.location, url).toString();
				const decision = checkUrl(target, redirectPolicyOf(options.allowedHosts));
				redirects.push({ from: current, to: decision.ok ? decision.url : target, status });
				if (!decision.ok) {
					return fail("REDIRECT_BLOCKED", `重定向目标被拒绝：${decision.reason}`, {
						status,
						blockedTarget: target,
						blockedReason: decision.reason,
					});
				}
				if (hop + 1 > maxRedirects) return fail("TOO_MANY_REDIRECTS", `重定向超过 ${maxRedirects} 次`, { status });
				current = decision.url;
				continue;
			}

			const { mimeType, charset } = parseContentType(response.headers["content-type"]);
			const isSuccess = status >= 200 && status < 300;
			if (isSuccess && options.allowedMimeTypes.length > 0 && !options.allowedMimeTypes.includes(mimeType ?? "")) {
				response.destroy();
				return fail("MIME_REJECTED", `内容类型 ${mimeType ?? "未声明"} 不在允许范围`, { status });
			}
			const body = await readBody(response, options.maxBytes, register);
			const headers: Record<string, string> = {};
			for (const [name, value] of Object.entries(response.headers)) {
				if (typeof value === "string") headers[name] = value;
				else if (Array.isArray(value)) headers[name] = value.join(", ");
			}
			return {
				ok: true,
				url: input,
				finalUrl: current,
				status,
				headers,
				mimeType,
				charset,
				body,
				redirects,
				durationMs: Date.now() - started,
				address,
			};
		}
	} catch (error) {
		if (error instanceof FetchAbort) {
			const extra: Partial<SafeFetchError> = { status: error.status };
			if (error.code === "ADDRESS_BLOCKED") extra.blockedReason = "PRIVATE_ADDRESS";
			return fail(error.code, error.message, extra);
		}
		if (timedOut) return fail("TIMEOUT", timeout.message);
		return fail("NETWORK", (error as Error).message);
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", onAbort);
	}
}
