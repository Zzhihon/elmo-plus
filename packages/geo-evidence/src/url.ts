const TRACKING_PARAMS = new Set([
	"fbclid",
	"gclid",
	"dclid",
	"msclkid",
	"yclid",
	"bd_vid",
	"spm",
	"_hsenc",
	"_hsmi",
	"mc_cid",
	"mc_eid",
	"ref_src",
]);

const UNRESERVED_ENCODED = /%(2[DE]|5F|7E|3[0-9]|[46][1-9A-F]|[57][0-9A])/gi;

function normalizePercentEncoding(value: string): string {
	return value
		.replace(/%[0-9a-f]{2}/gi, (escape) => escape.toUpperCase())
		.replace(UNRESERVED_ENCODED, (escape) => String.fromCharCode(Number.parseInt(escape.slice(1), 16)));
}

function isTracking(name: string): boolean {
	const lower = name.toLowerCase();
	return lower.startsWith("utm_") || TRACKING_PARAMS.has(lower);
}

function parseWebUrl(input: string, base?: string): URL | null {
	try {
		const url = new URL(input.trim(), base);
		return url.protocol === "http:" || url.protocol === "https:" ? url : null;
	} catch {
		return null;
	}
}

/**
 * The identity of a page or a citation: fragments, credentials, default ports,
 * tracking parameters and a trailing slash do not change what it points at.
 * `http` and `https`, and `www` and the bare host, stay distinct because nothing
 * here can prove they serve the same content. Null for anything not a web URL.
 */
export function normalizeUrl(input: string, base?: string): string | null {
	const url = parseWebUrl(input, base);
	if (!url) return null;

	url.username = "";
	url.password = "";
	url.hash = "";
	url.hostname = url.hostname.replace(/\.$/, "");

	const params = [...url.searchParams.entries()]
		.filter(([name]) => !isTracking(name))
		.sort(([a, aValue], [b, bValue]) => (a === b ? (aValue < bValue ? -1 : 1) : a < b ? -1 : 1));
	url.search = new URLSearchParams(params).toString();

	const path = normalizePercentEncoding(url.pathname).replace(/\/{2,}/g, "/");
	url.pathname = path.length > 1 ? path.replace(/\/$/, "") : "/";

	return url.toString();
}

/** Lower-cased and punycoded, with no port. Null for anything not a web URL. */
export function hostOf(input: string): string | null {
	const url = parseWebUrl(input);
	return url ? url.hostname.replace(/\.$/, "") : null;
}
