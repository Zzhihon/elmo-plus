#!/usr/bin/env node
// Usage: GEO_MCP_URL=https://app.example.com GEO_MCP_KEY_FILE=~/.geo-mcp-key \
//          node sync.mjs <results/<planKey> dir> [--dry-run]
// Uploads screenshots that have no evidenceRef yet, writes the refs back into
// observations.jsonl, then imports every row. Safe to rerun: the server skips
// runKeys it already holds.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { contentTypeFor, latestRows, OBSERVATIONS_FILE, readRows, resultsDirArg } from "./lib.mjs";

const CHUNK = 50;
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const dir = resultsDirArg(args);
const planKey = basename(dir);

const entries = readRows(dir);
const broken = entries.filter((e) => e.parseError);
if (broken.length) {
	console.error(`unparseable lines: ${broken.map((e) => e.line).join(", ")} — run validate.mjs first`);
	process.exit(1);
}
const rows = entries.map((e) => e.row);
if (rows.length === 0) {
	console.error(`no rows in ${join(dir, OBSERVATIONS_FILE)}`);
	process.exit(1);
}

function endpoint() {
	const raw = process.env.GEO_MCP_URL;
	if (!raw) throw new Error("GEO_MCP_URL is not set");
	const url = new URL(raw);
	if (!url.pathname.replace(/\/$/, "").endsWith("/api/mcp"))
		url.pathname = `${url.pathname.replace(/\/$/, "")}/api/mcp`;
	return url.toString();
}

function apiKey() {
	const file = process.env.GEO_MCP_KEY_FILE?.replace(/^~(?=\/)/, homedir());
	if (!file) throw new Error("GEO_MCP_KEY_FILE is not set");
	return readFileSync(file, "utf8").trim();
}

function createClient(url, key) {
	let nextId = 1;
	const headers = {
		"Content-Type": "application/json",
		Accept: "application/json, text/event-stream",
		Authorization: `Bearer ${key}`,
	};

	async function post(body) {
		const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
		const session = res.headers.get("mcp-session-id");
		if (session) headers["Mcp-Session-Id"] = session;
		const text = await res.text();
		if (!res.ok && res.status !== 202) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
		if (!text) return null;
		// A server may answer as an SSE stream even when JSON was acceptable.
		const json = res.headers.get("content-type")?.includes("text/event-stream")
			? text
					.split("\n")
					.filter((l) => l.startsWith("data:"))
					.map((l) => l.slice(5))
					.join("")
			: text;
		const message = JSON.parse(json);
		if (message.error) throw new Error(`JSON-RPC ${message.error.code}: ${message.error.message}`);
		return message.result;
	}

	return {
		async initialize() {
			const result = await post({
				jsonrpc: "2.0",
				id: nextId++,
				method: "initialize",
				params: {
					protocolVersion: "2025-06-18",
					capabilities: {},
					clientInfo: { name: "geo-browser-sampler-sync", version: "1.0.0" },
				},
			});
			headers["MCP-Protocol-Version"] = result.protocolVersion;
			await post({ jsonrpc: "2.0", method: "notifications/initialized" });
			return result;
		},
		async call(name, input) {
			const result = await post({
				jsonrpc: "2.0",
				id: nextId++,
				method: "tools/call",
				params: { name, arguments: input },
			});
			const text = result.content?.find((c) => c.type === "text")?.text ?? "";
			if (result.isError) throw new Error(`${name}: ${text}`);
			return JSON.parse(text);
		},
	};
}

function saveRows() {
	const file = join(dir, OBSERVATIONS_FILE);
	writeFileSync(`${file}.tmp`, rows.map((r) => `${JSON.stringify(r)}\n`).join(""));
	renameSync(`${file}.tmp`, file);
}

const current = latestRows(rows);
const pending = current.filter((r) => r.evidence?.length && r.evidenceRefs?.length !== r.evidence.length);
const missing = pending.flatMap((r) => r.evidence.filter((shot) => !existsSync(join(dir, shot))));
console.log(
	`${current.length} run(s), ${pending.length} needing screenshot upload, ${Math.ceil(current.length / CHUNK)} import chunk(s)`,
);
if (missing.length) console.warn(`missing screenshots (rows will import without them): ${missing.join(", ")}`);

if (dryRun) {
	for (const r of pending) console.log(`  would upload ${r.evidence.join(", ")} for ${r.runKey}`);
	console.log(`  would import ${current.length} run(s) into ${planKey}`);
	process.exit(0);
}

process.on("uncaughtException", (err) => {
	console.error(`sync failed: ${err.message}`);
	process.exit(1);
});

const client = createClient(endpoint(), apiKey());
await client.initialize();

for (const row of pending) {
	const refs = [];
	for (const shot of row.evidence) {
		const path = join(dir, shot);
		const contentType = contentTypeFor(shot);
		if (!existsSync(path) || !contentType) continue;
		const { evidenceRef } = await client.call("geo_upload_evidence", {
			fileName: basename(shot),
			contentType,
			contentBase64: readFileSync(path).toString("base64"),
		});
		refs.push(evidenceRef);
	}
	if (refs.length === row.evidence.length) {
		row.evidenceRefs = refs;
		saveRows();
	}
	console.log(`  uploaded ${refs.length}/${row.evidence.length} for ${row.runKey}`);
}

const totals = { created: 0, skipped: 0, failedRecorded: 0, errors: [] };
for (let i = 0; i < current.length; i += CHUNK) {
	const result = await client.call("geo_import_browser_observations", { planKey, rows: current.slice(i, i + CHUNK) });
	totals.created += result.created ?? 0;
	totals.skipped += result.skipped ?? 0;
	totals.failedRecorded += result.failedRecorded ?? 0;
	totals.errors.push(...(result.errors ?? []));
}

writeFileSync(
	join(dir, "sync-result.json"),
	`${JSON.stringify({ syncedAt: new Date().toISOString(), ...totals }, null, 2)}\n`,
);
console.log(`created ${totals.created}, skipped ${totals.skipped}, failedRecorded ${totals.failedRecorded}`);
for (const e of totals.errors) console.log(`  error ${e.runKey} ${e.field}: ${e.message}`);
process.exit(totals.errors.length ? 1 : 0);
