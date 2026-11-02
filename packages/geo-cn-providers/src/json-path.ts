const SEGMENT = /([^.[\]]+)|\[(\d+)\]/g;

/** Reads `a.b[0].c` from parsed JSON. Anything missing along the way gives undefined. */
export function readPath(value: unknown, path: string): unknown {
	let current: unknown = value;
	for (const match of path.matchAll(SEGMENT)) {
		if (current === null || current === undefined) return undefined;
		const [, key, index] = match;
		if (index !== undefined) {
			if (!Array.isArray(current)) return undefined;
			current = current[Number(index)];
		} else {
			if (typeof current !== "object") return undefined;
			current = (current as Record<string, unknown>)[key];
		}
	}
	return current;
}

export function isValidPath(path: unknown): path is string {
	return typeof path === "string" && path.length > 0 && path.length <= 200 && /^[A-Za-z0-9_$\-.[\]]+$/.test(path);
}

/** Replaces `{{name}}` in every string of a JSON template; a string that is exactly one placeholder takes the raw value. */
export function fillTemplate(template: unknown, values: Record<string, string | undefined>): unknown {
	if (typeof template === "string") {
		const whole = /^\{\{(\w+)\}\}$/.exec(template);
		if (whole) return values[whole[1]] ?? "";
		return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => values[name] ?? "");
	}
	if (Array.isArray(template)) return template.map((item) => fillTemplate(item, values));
	if (template && typeof template === "object") {
		return Object.fromEntries(Object.entries(template).map(([key, item]) => [key, fillTemplate(item, values)]));
	}
	return template;
}
