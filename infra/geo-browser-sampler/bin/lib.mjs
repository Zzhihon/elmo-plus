import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const schemaPath = join(dirname(fileURLToPath(import.meta.url)), "..", "schema", "observation.schema.json");
export const schema = JSON.parse(readFileSync(schemaPath, "utf8"));

export const OBSERVATIONS_FILE = "observations.jsonl";

const typeOf = (value) => (Array.isArray(value) ? "array" : value === null ? "null" : typeof value);

function matches(node, value) {
	return validateNode(node, value, "").length === 0;
}

function checkString(node, value) {
	const problems = [];
	if (node.minLength !== undefined && value.length < node.minLength) problems.push("must not be empty");
	if (node.pattern && !new RegExp(node.pattern).test(value)) problems.push(`does not match ${node.pattern}`);
	if (node.format === "date-time" && Number.isNaN(Date.parse(value))) problems.push("is not a valid date-time");
	return problems;
}

function checkArray(node, value, path, fail) {
	if (node.minItems !== undefined && value.length < node.minItems) fail(`needs at least ${node.minItems} item(s)`);
	if (!node.items) return [];
	return value.flatMap((item, i) => validateNode(node.items, item, `${path}[${i}]`));
}

function checkObject(node, value, path, fail) {
	for (const key of node.required ?? []) if (!(key in value)) fail(`missing ${key}`);
	return Object.entries(value).flatMap(([key, child]) => {
		const sub = node.properties?.[key];
		if (sub) return validateNode(sub, child, path ? `${path}.${key}` : key);
		if (node.additionalProperties === false) fail(`unknown field ${key}`);
		return [];
	});
}

// Only the keywords observation.schema.json uses; keep the two in step.
function validateNode(node, value, path) {
	const errors = [];
	const fail = (message) => errors.push({ field: path || "(row)", message });
	const t = typeOf(value);

	if (node.type && node.type !== t) {
		fail(`expected ${node.type}, got ${t}`);
		return errors;
	}
	if ("const" in node && value !== node.const) fail(`must be ${JSON.stringify(node.const)}`);
	if (node.enum && !node.enum.includes(value)) fail(`must be one of ${node.enum.join(", ")}`);
	if (t === "string") checkString(node, value).forEach(fail);
	if (t === "array") errors.push(...checkArray(node, value, path, fail));
	if (t === "object") errors.push(...checkObject(node, value, path, fail));
	for (const part of node.allOf ?? []) {
		if (!part.if || matches(part.if, value)) errors.push(...validateNode(part.then ?? part, value, path));
	}
	return errors;
}

export function validateRow(row) {
	const errors = validateNode(schema, row, "");
	if (errors.length === 0) {
		const expected = `${row.planKey}/${row.platform}/${row.promptId}/`;
		if (!row.runKey.startsWith(expected)) {
			errors.push({ field: "runKey", message: `must start with ${expected}` });
		}
	}
	return errors;
}

/** Monday 00:00 to the next Monday 00:00, Asia/Shanghai, for an ISO week key. */
export function planWeek(planKey) {
	const [, year, week] = /^(\d{4})-W(\d{2})$/.exec(planKey) ?? [];
	if (!year) return null;
	const jan4 = Date.UTC(Number(year), 0, 4);
	const jan4Weekday = (new Date(jan4).getUTCDay() + 6) % 7;
	const mondayUtc = jan4 - jan4Weekday * 86_400_000 + (Number(week) - 1) * 7 * 86_400_000;
	const start = mondayUtc - 8 * 3_600_000;
	return { start: new Date(start), end: new Date(start + 7 * 86_400_000) };
}

export function readRows(resultsDir) {
	const file = join(resultsDir, OBSERVATIONS_FILE);
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8")
		.split("\n")
		.map((line, index) => ({ line: index + 1, text: line.trim() }))
		.filter(({ text }) => text.length > 0)
		.map(({ line, text }) => {
			try {
				return { line, row: JSON.parse(text) };
			} catch (err) {
				return { line, parseError: err.message };
			}
		});
}

export function contentTypeFor(fileName) {
	if (/\.png$/i.test(fileName)) return "image/png";
	if (/\.jpe?g$/i.test(fileName)) return "image/jpeg";
	if (/\.pdf$/i.test(fileName)) return "application/pdf";
	return null;
}

export function resultsDirArg(argv) {
	const dir = argv.find((arg) => !arg.startsWith("--"));
	if (!dir) {
		console.error("usage: <script> <results/planKey dir> [options]");
		process.exit(2);
	}
	return resolve(dir);
}
