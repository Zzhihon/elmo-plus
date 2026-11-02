export interface RobotsRule {
	allow: boolean;
	pattern: string;
}

export interface RobotsPolicy {
	/** How the policy was obtained, kept on the crawl run as evidence. */
	source: "FILE" | "NOT_FOUND" | "UNAVAILABLE";
	httpStatus: number | null;
	rules: RobotsRule[];
	crawlDelaySeconds: number | null;
	sitemaps: string[];
}

interface Group {
	agents: string[];
	rules: RobotsRule[];
	crawlDelay: number | null;
}

function parseLine(rawLine: string): { key: string; value: string } | null {
	const line = rawLine.replace(/#.*$/, "").trim();
	const colon = line.indexOf(":");
	if (!line || colon < 0) return null;
	return { key: line.slice(0, colon).trim().toLowerCase(), value: line.slice(colon + 1).trim() };
}

function applyDirective(group: Group, key: string, value: string): void {
	if (key === "allow" || key === "disallow") {
		if (value || key === "allow") group.rules.push({ allow: key === "allow", pattern: value });
		return;
	}
	if (key === "crawl-delay") {
		const delay = Number(value);
		if (Number.isFinite(delay) && delay >= 0) group.crawlDelay = delay;
	}
}

interface ParseState {
	groups: Group[];
	sitemaps: string[];
	lastWasAgent: boolean;
}

function handleLine(state: ParseState, key: string, value: string): void {
	if (key === "sitemap") {
		if (value) state.sitemaps.push(value);
		return;
	}
	const current = state.groups.at(-1);
	if (key === "user-agent") {
		const group = current && state.lastWasAgent ? current : { agents: [], rules: [], crawlDelay: null };
		if (group !== current) state.groups.push(group);
		group.agents.push(value.toLowerCase());
		state.lastWasAgent = true;
		return;
	}
	state.lastWasAgent = false;
	if (current) applyDirective(current, key, value);
}

function parseGroups(text: string): { groups: Group[]; sitemaps: string[] } {
	const state: ParseState = { groups: [], sitemaps: [], lastWasAgent: false };
	for (const rawLine of text.split(/\r?\n/)) {
		const parsed = parseLine(rawLine);
		if (parsed) handleLine(state, parsed.key, parsed.value);
	}
	return { groups: state.groups, sitemaps: state.sitemaps };
}

/** RFC 9309: the most specific matching group for our product token, else the `*` group. */
export function parseRobots(text: string, productToken: string, httpStatus = 200): RobotsPolicy {
	const { groups, sitemaps } = parseGroups(text);
	const token = productToken.toLowerCase();
	const own = groups.filter((group) => group.agents.some((agent) => agent !== "*" && token.includes(agent)));
	const chosen = own.length > 0 ? own : groups.filter((group) => group.agents.includes("*"));
	return {
		source: "FILE",
		httpStatus,
		rules: chosen.flatMap((group) => group.rules),
		crawlDelaySeconds: chosen.reduce<number | null>(
			(max, group) => (group.crawlDelay === null ? max : Math.max(max ?? 0, group.crawlDelay)),
			null,
		),
		sitemaps,
	};
}

/**
 * RFC 9309 §2.3.1: a robots.txt that answers 4xx means no restrictions; one that
 * cannot be fetched or answers 5xx means the whole site is off limits until it can be.
 */
export function robotsFromStatus(httpStatus: number | null): RobotsPolicy {
	const notFound = httpStatus !== null && httpStatus >= 400 && httpStatus < 500;
	return {
		source: notFound ? "NOT_FOUND" : "UNAVAILABLE",
		httpStatus,
		rules: notFound ? [] : [{ allow: false, pattern: "/" }],
		crawlDelaySeconds: null,
		sitemaps: [],
	};
}

function patternToRegex(pattern: string): RegExp {
	const anchored = pattern.endsWith("$");
	const body = (anchored ? pattern.slice(0, -1) : pattern)
		.split("*")
		.map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
		.join(".*");
	return new RegExp(`^${body}${anchored ? "$" : ""}`);
}

/** Longest match wins; on a tie, allow wins. */
export function isAllowedByRobots(policy: RobotsPolicy, pathAndQuery: string): boolean {
	let best: RobotsRule | null = null;
	for (const rule of policy.rules) {
		if (rule.pattern === "") continue;
		if (!patternToRegex(rule.pattern).test(pathAndQuery)) continue;
		if (
			!best ||
			rule.pattern.length > best.pattern.length ||
			(rule.pattern.length === best.pattern.length && rule.allow)
		) {
			best = rule;
		}
	}
	return best ? best.allow : true;
}
