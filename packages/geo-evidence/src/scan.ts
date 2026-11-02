import { Socket } from "node:net";

/**
 * Malware scanning through clamd's INSTREAM command. With no clamd configured an
 * upload is accepted as UNSCANNED and the UI has to say so; with one configured but
 * unreachable the scan throws, so a broken scanner never quietly waves files through.
 */

export type GeoScanOutcome =
	| { status: "CLEAN"; engine: "clamd" }
	| { status: "INFECTED"; engine: "clamd"; signature: string }
	| { status: "UNSCANNED"; engine: null };

export class ScanUnavailableError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "ScanUnavailableError";
	}
}

export interface ClamdConfig {
	host: string;
	port: number;
	timeoutMs?: number;
}

const DEFAULT_PORT = 3310;
const DEFAULT_TIMEOUT_MS = 30_000;
const CHUNK_BYTES = 64 * 1024;

export function clamdConfigFromEnv(env: Record<string, string | undefined> = process.env): ClamdConfig | null {
	const host = env.GEO_CLAMD_HOST?.trim();
	if (!host) return null;
	const rawPort = env.GEO_CLAMD_PORT?.trim();
	const port = rawPort ? Number(rawPort) : DEFAULT_PORT;
	if (!Number.isInteger(port) || port <= 0 || port > 65535) {
		throw new ScanUnavailableError("GEO_CLAMD_PORT is not a valid port");
	}
	return { host, port };
}

function frame(body: Uint8Array): Buffer[] {
	const frames: Buffer[] = [Buffer.from("zINSTREAM\0")];
	for (let offset = 0; offset < body.length; offset += CHUNK_BYTES) {
		const chunk = body.subarray(offset, Math.min(offset + CHUNK_BYTES, body.length));
		const length = Buffer.alloc(4);
		length.writeUInt32BE(chunk.length, 0);
		frames.push(length, Buffer.from(chunk));
	}
	frames.push(Buffer.alloc(4));
	return frames;
}

export function parseClamdReply(reply: string): GeoScanOutcome {
	const text = reply.replace(/\0+$/, "").trim();
	if (/^stream: OK$/.test(text)) return { status: "CLEAN", engine: "clamd" };
	const found = /^stream: (.+) FOUND$/.exec(text);
	if (found) return { status: "INFECTED", engine: "clamd", signature: found[1] };
	throw new ScanUnavailableError(`clamd could not scan the file: ${text.slice(0, 200)}`);
}

function streamToClamd(body: Uint8Array, config: ClamdConfig): Promise<string> {
	return new Promise((resolve, reject) => {
		const socket = new Socket();
		const chunks: Buffer[] = [];
		let settled = false;
		const finish = (error: Error | null, reply?: string) => {
			if (settled) return;
			settled = true;
			socket.destroy();
			if (error) reject(error);
			else resolve(reply ?? "");
		};

		socket.setTimeout(config.timeoutMs ?? DEFAULT_TIMEOUT_MS, () =>
			finish(new ScanUnavailableError("clamd did not answer in time")),
		);
		socket.on("error", (error) => finish(new ScanUnavailableError("clamd is unreachable", { cause: error })));
		socket.on("data", (data) => {
			chunks.push(data);
			if (data.includes(0)) finish(null, Buffer.concat(chunks).toString("utf8"));
		});
		socket.on("end", () => finish(null, Buffer.concat(chunks).toString("utf8")));
		socket.connect(config.port, config.host, () => {
			for (const part of frame(body)) socket.write(part);
		});
	});
}

export async function scanUpload(
	body: Uint8Array,
	options: { config?: ClamdConfig | null; env?: Record<string, string | undefined> } = {},
): Promise<GeoScanOutcome> {
	const config = options.config === undefined ? clamdConfigFromEnv(options.env) : options.config;
	if (!config) return { status: "UNSCANNED", engine: null };
	return parseClamdReply(await streamToClamd(body, config));
}
