#!/usr/bin/env node
// Usage: node append.mjs <results/<planKey> dir> [--answer-file answer.txt] < row.json
// Appends one observation row after checking it. --answer-file sets responseText
// from a file so long answers never pass through shell quoting.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { OBSERVATIONS_FILE, readRows, resultsDirArg, validateRow } from "./lib.mjs";

const args = process.argv.slice(2);
const dir = resultsDirArg(args);
const answerFlag = args.indexOf("--answer-file");

const row = JSON.parse(readFileSync(0, "utf8"));
if (answerFlag !== -1) row.responseText = readFileSync(args[answerFlag + 1], "utf8").trim();
row.citations ??= [];
row.evidence ??= [];
row.evidenceRefs ??= [];

const errors = validateRow(row);
if (readRows(dir).some((entry) => entry.row?.runKey === row.runKey)) {
	errors.push({ field: "runKey", message: "already recorded; skip this run" });
}
if (errors.length) {
	for (const e of errors) console.error(`${row.runKey ?? "-"} ${e.field}: ${e.message}`);
	process.exit(1);
}

mkdirSync(join(dir, "shots"), { recursive: true });
appendFileSync(join(dir, OBSERVATIONS_FILE), `${JSON.stringify(row)}\n`);
console.log(`appended ${row.runKey} (${row.status})`);
