import { createHash } from "node:crypto";

const REDACTED = "[REDACTED]";
const MIN_SECRET_LENGTH = 6;

const SECRET_PATTERNS: RegExp[] = [
	/(\bBearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
	/(\b(?:authorization|x-api-key|api-key)\s*[:=]\s*)["']?[^\s"',;}]{6,}/gi,
	/([?&](?:api[_-]?key|access[_-]?token|token|key|secret|signature|sig)=)[^&#\s"']+/gi,
	/("(?:api[_-]?key|apiKey|access[_-]?token|accessToken|secret|password|token|authorization)"\s*:\s*")[^"]*/gi,
	/\b(sk|ak|pk)-[A-Za-z0-9_-]{16,}/g,
];

/** Hides every known secret value and anything shaped like a credential. */
export function redactSecrets(text: string, secrets: readonly (string | null | undefined)[] = []): string {
	let result = text;
	const known = secrets
		.filter((secret): secret is string => typeof secret === "string" && secret.length >= MIN_SECRET_LENGTH)
		.sort((a, b) => b.length - a.length);
	for (const secret of known) result = result.split(secret).join(REDACTED);
	for (const pattern of SECRET_PATTERNS) {
		result = result.replace(pattern, (match, prefix?: string) =>
			typeof prefix === "string" && match.startsWith(prefix) ? `${prefix}${REDACTED}` : REDACTED,
		);
	}
	return result;
}

/** Stands in for a question or an answer in logs: enough to correlate, nothing to read. */
export function describeText(text: string | null | undefined): string {
	if (!text) return "[空文本]";
	const digest = createHash("sha256").update(text).digest("hex").slice(0, 12);
	return `[已隐藏文本 ${[...text].length} 字 sha256:${digest}]`;
}

const SECRET_KEY = /secret|password|passwd|token|credential|api[-_]?key|authorization|cookie/i;
const CONTENT_KEY =
	/^(prompt|prompt_?text|question|question_?text|response|response_?text|answer|content|text|messages|body)$/i;

/**
 * Log-safe copy of a value: credential-like keys are replaced, question and answer
 * text is reduced to a length and hash, and remaining strings are scrubbed.
 */
export function redactForLog(
	value: unknown,
	options: {
		secrets?: readonly (string | null | undefined)[];
		sensitiveTexts?: readonly (string | null | undefined)[];
	} = {},
): unknown {
	const sensitive = (options.sensitiveTexts ?? []).filter(
		(text): text is string => typeof text === "string" && text.length > 0,
	);
	const scrub = (text: string): string => {
		let result = redactSecrets(text, options.secrets);
		for (const item of sensitive) {
			if (result.includes(item)) result = result.split(item).join(describeText(item));
		}
		return result;
	};
	const isContent = (key: string | null) => key !== null && CONTENT_KEY.test(key);
	const walk = (entry: unknown, key: string | null, depth: number): unknown => {
		if (key !== null && SECRET_KEY.test(key)) return REDACTED;
		if (typeof entry === "string") return isContent(key) ? describeText(entry) : scrub(entry);
		if (entry === null || typeof entry !== "object") return entry;
		return walkObject(entry, key, depth);
	};
	const walkObject = (entry: object, key: string | null, depth: number): unknown => {
		if (depth > 6) return "[…]";
		if (entry instanceof Date) return entry.toISOString();
		if (Array.isArray(entry)) {
			return isContent(key) ? `[已隐藏 ${entry.length} 项]` : entry.map((item) => walk(item, null, depth + 1));
		}
		return Object.fromEntries(
			Object.entries(entry).map(([childKey, child]) => [childKey, walk(child, childKey, depth + 1)]),
		);
	};
	return walk(value, null, 0);
}

const MAX_DETAIL = 300;

/** For `error_detail` and log lines: the message only, scrubbed and cut short. */
export function safeErrorDetail(
	error: unknown,
	options: {
		secrets?: readonly (string | null | undefined)[];
		sensitiveTexts?: readonly (string | null | undefined)[];
	} = {},
): string {
	const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
	const scrubbed = redactForLog(message, options) as string;
	return scrubbed.length > MAX_DETAIL ? `${scrubbed.slice(0, MAX_DETAIL)}…` : scrubbed;
}
