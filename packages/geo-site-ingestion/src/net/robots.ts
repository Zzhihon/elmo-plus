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

function parseGroups(text: string): { groups: Group[]; sitemaps: string[] } {
	const groups: Group[] = [];
	const sitemaps: string[] = [];
	let current: Group | null = null;
	let lastWasAgent = false;
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.replace(/#.*$/, "").trim();
		if (!line) continue;
		const colon = line.indexOf(":");
		if (colon < 0) continue;
		const key = line.slice(0, colon).trim().toLowerCase();
		const value = line.slice(colon + 1).trim();
		if (key === "sitemap") {
			if (value) sitemaps.push(value);
			continue;
		}
		if (key === "user-agent") {
			if (!current || !lastWasAgent) {
				current = { agents: [], rules: [], crawlDelay: null };
				groups.push(current);
			}
			current.agents.push(value.toLowerCase());
			lastWasAgent = true;
			continue;
		}
		lastWasAgent = false;
		if (!current) continue;
		if (key === "allow" || key === "disallow") {
			if (value || key === "allow") current.rules.push({ allow: key === "allow", pattern: value });
		} else if (key === "crawl-delay") {
			const delay = Number(value);
			if (Number.isFinite(delay) && delay >= 0) current.crawlDelay = delay;
		}
	}
	return { groups, sitemaps };
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
