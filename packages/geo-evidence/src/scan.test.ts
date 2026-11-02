import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ScanUnavailableError, scanUpload } from "./scan";

let server: Server | null = null;

afterEach(async () => {
	await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
	server = null;
});

/** A stand-in clamd that reads the INSTREAM frames and answers with `reply(body)`. */
async function fakeClamd(reply: (body: Buffer) => string): Promise<number> {
	server = createServer((socket) => {
		let buffer = Buffer.alloc(0);
		socket.on("data", (data) => {
			buffer = Buffer.concat([buffer, data]);
			const command = Buffer.from("zINSTREAM\0");
			if (buffer.length < command.length) return;
			const parts: Buffer[] = [];
			let offset = command.length;
			while (offset + 4 <= buffer.length) {
				const length = buffer.readUInt32BE(offset);
				if (length === 0) {
					socket.end(`${reply(Buffer.concat(parts))}\0`);
					return;
				}
				if (offset + 4 + length > buffer.length) return;
				parts.push(buffer.subarray(offset + 4, offset + 4 + length));
				offset += 4 + length;
			}
		});
	});
	await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", () => resolve()));
	const address = server?.address();
	if (!address || typeof address === "string") throw new Error("no port");
	return address.port;
}

describe("scanUpload", () => {
	it("records UNSCANNED instead of failing when no scanner is configured", async () => {
		await expect(scanUpload(new Uint8Array([1, 2, 3]), { env: {} })).resolves.toEqual({
			status: "UNSCANNED",
			engine: null,
		});
	});

	it("streams the whole file and reports a clean result", async () => {
		const body = new Uint8Array(200_000).fill(7);
		let received = 0;
		const port = await fakeClamd((data) => {
			received = data.length;
			return "stream: OK";
		});
		await expect(scanUpload(body, { config: { host: "127.0.0.1", port } })).resolves.toEqual({
			status: "CLEAN",
			engine: "clamd",
		});
		expect(received).toBe(body.length);
	});

	it("reports the signature of an infected file", async () => {
		const port = await fakeClamd(() => "stream: Eicar-Test-Signature FOUND");
		await expect(scanUpload(new Uint8Array([1]), { config: { host: "127.0.0.1", port } })).resolves.toEqual({
			status: "INFECTED",
			engine: "clamd",
			signature: "Eicar-Test-Signature",
		});
	});

	it("fails closed when clamd answers with an error", async () => {
		const port = await fakeClamd(() => "INSTREAM size limit exceeded. ERROR");
		await expect(scanUpload(new Uint8Array([1]), { config: { host: "127.0.0.1", port } })).rejects.toThrow(
			ScanUnavailableError,
		);
	});

	it("fails closed when the configured scanner is unreachable", async () => {
		const port = await fakeClamd(() => "stream: OK");
		await new Promise<void>((resolve) => server?.close(() => resolve()));
		server = null;
		await expect(
			scanUpload(new Uint8Array([1]), { config: { host: "127.0.0.1", port, timeoutMs: 2000 } }),
		).rejects.toThrow(ScanUnavailableError);
	});
});
