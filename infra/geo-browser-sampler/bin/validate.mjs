#!/usr/bin/env node
// Usage: node validate.mjs <results/<planKey> dir>
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { planWeek, readRows, resultsDirArg, validateRow } from "./lib.mjs";

const dir = resultsDirArg(process.argv.slice(2));
const planKey = basename(dir);
const week = planWeek(planKey);
const errors = [];
const warnings = [];
const report = (list, line, runKey, field, message) => list.push({ line, runKey, field, message });

if (!week) report(errors, 0, "-", "dir", `directory name ${planKey} is not a plan key like 2026-W45`);

const planFile = join(dir, "plan.json");
const plan = existsSync(planFile) ? JSON.parse(readFileSync(planFile, "utf8")) : null;
const planPrompts = plan ? new Set(plan.questions.map((q) => q.promptId)) : null;
const planPlatforms = plan ? new Set(plan.platforms.map((p) => p.platform)) : null;

const entries = readRows(dir);
if (entries.length === 0) report(errors, 0, "-", "file", "observations.jsonl is missing or empty");

const seen = new Map();
const table = new Map();

for (const { line, row, parseError } of entries) {
	if (parseError) {
		report(errors, line, "-", "json", parseError);
		continue;
	}
	const runKey = row.runKey ?? "-";
	for (const e of validateRow(row)) report(errors, line, runKey, e.field, e.message);

	if (seen.has(runKey)) report(errors, line, runKey, "runKey", `duplicate of line ${seen.get(runKey)}`);
	else seen.set(runKey, line);

	if (row.planKey && row.planKey !== planKey) report(errors, line, runKey, "planKey", `is not ${planKey}`);

	const at = Date.parse(row.sampledAt);
	if (week && !Number.isNaN(at) && (at < week.start || at >= week.end)) {
		report(
			errors,
			line,
			runKey,
			"sampledAt",
			`outside plan week ${week.start.toISOString()}..${week.end.toISOString()}`,
		);
	}

	if (row.status !== "FAILED") {
		for (const shot of row.evidence ?? []) {
			if (!existsSync(join(dir, shot))) report(errors, line, runKey, "evidence", `${shot} not found`);
		}
	}
	if (row.evidenceRefs?.length && row.evidenceRefs.length !== row.evidence?.length) {
		report(warnings, line, runKey, "evidenceRefs", "count differs from evidence; sync will re-upload");
	}
	if (planPrompts && row.promptId && !planPrompts.has(row.promptId)) {
		report(errors, line, runKey, "promptId", "not in plan.json");
	}
	if (planPlatforms && row.platform && !planPlatforms.has(row.platform)) {
		report(errors, line, runKey, "platform", "not in plan.json");
	}
	if (row.status === "VALID" && !row.citations?.length) {
		report(warnings, line, runKey, "citations", "VALID with no citations (fine if the app showed none)");
	}

	const counts = table.get(row.platform) ?? { VALID: 0, PARTIAL: 0, FAILED: 0, codes: {} };
	if (row.status in counts) counts[row.status] += 1;
	if (row.failure?.code) counts.codes[row.failure.code] = (counts.codes[row.failure.code] ?? 0) + 1;
	table.set(row.platform, counts);
}

const expectedPerPlatform = plan ? plan.questions.length * (plan.repeats ?? 1) : null;
console.log(`| Platform | Valid | Partial | Failed | Total${plan ? " / Planned" : ""} | Failure Codes |`);
console.log(`|---|---|---|---|---|---|`);
for (const [platform, c] of [...table.entries()].sort()) {
	const total = c.VALID + c.PARTIAL + c.FAILED;
	const codes = Object.entries(c.codes)
		.map(([code, n]) => `${code}×${n}`)
		.join(" ");
	const totalCell = plan ? `${total} / ${expectedPerPlatform}` : `${total}`;
	console.log(`| ${platform} | ${c.VALID} | ${c.PARTIAL} | ${c.FAILED} | ${totalCell} | ${codes || "-"} |`);
}

const print = (label, list) => {
	if (list.length === 0) return;
	console.log(`\n${label} (${list.length}):`);
	for (const e of list) console.log(`  line ${e.line} ${e.runKey} ${e.field}: ${e.message}`);
};
print("Warnings", warnings);
print("Errors", errors);
console.log(errors.length ? `\nFAIL: ${errors.length} error(s)` : `\nOK: ${entries.length} row(s)`);
process.exit(errors.length ? 1 : 0);
