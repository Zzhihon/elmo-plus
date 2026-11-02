import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { AwsClient } from "aws4fetch";

export interface PutObjectResult {
	key: string;
	size: number;
	sha256: string;
}

export interface ObjectHead {
	size: number;
	contentType: string | null;
}

export interface StoredObject extends ObjectHead {
	body: Uint8Array;
}

/** Keys are private: serve objects through an authorized route, never hand a caller the store's location. */
export interface ObjectStore {
	put(key: string, body: Uint8Array | string, options?: { contentType?: string }): Promise<PutObjectResult>;
	get(key: string): Promise<StoredObject | null>;
	head(key: string): Promise<ObjectHead | null>;
	delete(key: string): Promise<void>;
}

export class ObjectStoreError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "ObjectStoreError";
	}
}

const SAFE_SEGMENT = /^[A-Za-z0-9._\-一-鿿]+$/;
const MAX_KEY_LENGTH = 1024;

/** Refused rather than cleaned up: a key that needs repair came from somewhere it should not have. */
export function assertSafeObjectKey(key: string): void {
	if (typeof key !== "string" || key.length === 0 || key.length > MAX_KEY_LENGTH) {
		throw new ObjectStoreError("Invalid object key: empty or too long");
	}
	for (const segment of key.split("/")) {
		if (segment === "." || segment === ".." || !SAFE_SEGMENT.test(segment)) {
			throw new ObjectStoreError("Invalid object key: unsafe path segment");
		}
	}
}

/** Every key starts with the organization, so one tenant's objects can never sit under another's prefix. */
export function geoObjectKey(organizationId: string, ...segments: string[]): string {
	const key = ["geo", organizationId, ...segments].join("/");
	assertSafeObjectKey(key);
	return key;
}

function toBytes(body: Uint8Array | string): Uint8Array {
	return typeof body === "string" ? new TextEncoder().encode(body) : body;
}

function digest(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function isMissing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

const CONTENT_TYPE_SUFFIX = ".content-type";

/** For development and tests; production evidence belongs in a versioned S3 bucket. */
export class FsObjectStore implements ObjectStore {
	private readonly root: string;

	constructor(root: string) {
		this.root = path.resolve(root);
	}

	/** The key check stops `..`; the realpath check stops a symlink planted inside the root. */
	private async resolve(key: string): Promise<string> {
		assertSafeObjectKey(key);
		if (key.endsWith(CONTENT_TYPE_SUFFIX)) throw new ObjectStoreError("Invalid object key: reserved suffix");
		const target = path.resolve(this.root, key);
		if (!target.startsWith(`${this.root}${path.sep}`)) {
			throw new ObjectStoreError("Invalid object key: escapes the store root");
		}
		await mkdir(this.root, { recursive: true });
		const realRoot = await realpath(this.root);
		let existing = path.dirname(target);
		for (;;) {
			try {
				const realDir = await realpath(existing);
				if (realDir !== realRoot && !realDir.startsWith(`${realRoot}${path.sep}`)) {
					throw new ObjectStoreError("Invalid object key: escapes the store root");
				}
				return target;
			} catch (error) {
				if (!isMissing(error)) throw error;
				existing = path.dirname(existing);
			}
		}
	}

	async put(key: string, body: Uint8Array | string, options?: { contentType?: string }): Promise<PutObjectResult> {
		const target = await this.resolve(key);
		const bytes = toBytes(body);
		await mkdir(path.dirname(target), { recursive: true });
		const temp = `${target}.${randomUUID()}.tmp`;
		const handle = await open(temp, "wx", 0o600);
		try {
			await handle.writeFile(bytes);
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(temp, target);
		if (options?.contentType) {
			await open(`${target}${CONTENT_TYPE_SUFFIX}`, "w", 0o600).then(async (typeHandle) => {
				await typeHandle.writeFile(options.contentType as string);
				await typeHandle.close();
			});
		} else {
			await rm(`${target}${CONTENT_TYPE_SUFFIX}`, { force: true });
		}
		return { key, size: bytes.byteLength, sha256: digest(bytes) };
	}

	private async contentType(target: string): Promise<string | null> {
		try {
			return await readFile(`${target}${CONTENT_TYPE_SUFFIX}`, "utf8");
		} catch (error) {
			if (isMissing(error)) return null;
			throw error;
		}
	}

	async get(key: string): Promise<StoredObject | null> {
		const target = await this.resolve(key);
		try {
			const body = await readFile(target);
			return { body: new Uint8Array(body), size: body.byteLength, contentType: await this.contentType(target) };
		} catch (error) {
			if (isMissing(error)) return null;
			throw error;
		}
	}

	async head(key: string): Promise<ObjectHead | null> {
		const target = await this.resolve(key);
		try {
			const info = await stat(target);
			return { size: info.size, contentType: await this.contentType(target) };
		} catch (error) {
			if (isMissing(error)) return null;
			throw error;
		}
	}

	async delete(key: string): Promise<void> {
		const target = await this.resolve(key);
		await rm(target, { force: true });
		await rm(`${target}${CONTENT_TYPE_SUFFIX}`, { force: true });
	}
}

export interface S3ObjectStoreConfig {
	/** Path-style base, e.g. `https://s3.example.test/bucket` or `https://s3.example.test/bucket/prefix`. */
	baseUrl: string;
	accessKeyId: string;
	secretAccessKey: string;
	region: string;
	timeoutMs?: number;
}

const DEFAULT_S3_TIMEOUT_MS = 60_000;

/** Errors name the operation and status only, so a bucket address or a signature never reaches a log. */
export class S3ObjectStore implements ObjectStore {
	private readonly client: AwsClient;
	private readonly baseUrl: string;
	private readonly timeoutMs: number;

	constructor(config: S3ObjectStoreConfig) {
		this.baseUrl = config.baseUrl.replace(/\/+$/, "");
		this.timeoutMs = config.timeoutMs ?? DEFAULT_S3_TIMEOUT_MS;
		this.client = new AwsClient({
			accessKeyId: config.accessKeyId,
			secretAccessKey: config.secretAccessKey,
			region: config.region,
			service: "s3",
			retries: 3,
		});
	}

	private url(key: string): string {
		assertSafeObjectKey(key);
		return `${this.baseUrl}/${key.split("/").map(encodeURIComponent).join("/")}`;
	}

	private async send(operation: string, key: string, init: RequestInit): Promise<Response> {
		try {
			return await this.client.fetch(this.url(key), { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
		} catch (error) {
			if (error instanceof ObjectStoreError) throw error;
			throw new ObjectStoreError(`Object store ${operation} failed: ${(error as Error)?.name ?? "error"}`);
		}
	}

	async put(key: string, body: Uint8Array | string, options?: { contentType?: string }): Promise<PutObjectResult> {
		const bytes = toBytes(body);
		const sha256 = digest(bytes);
		const response = await this.send("put", key, {
			method: "PUT",
			body: bytes as BodyInit,
			headers: {
				"content-type": options?.contentType ?? "application/octet-stream",
				"x-amz-content-sha256": sha256,
			},
		});
		if (!response.ok) throw new ObjectStoreError(`Object store put failed with status ${response.status}`);
		return { key, size: bytes.byteLength, sha256 };
	}

	async get(key: string): Promise<StoredObject | null> {
		const response = await this.send("get", key, { method: "GET" });
		if (response.status === 404) return null;
		if (!response.ok) throw new ObjectStoreError(`Object store get failed with status ${response.status}`);
		const body = new Uint8Array(await response.arrayBuffer());
		return { body, size: body.byteLength, contentType: response.headers.get("content-type") };
	}

	async head(key: string): Promise<ObjectHead | null> {
		const response = await this.send("head", key, { method: "HEAD" });
		if (response.status === 404) return null;
		if (!response.ok) throw new ObjectStoreError(`Object store head failed with status ${response.status}`);
		return {
			size: Number(response.headers.get("content-length") ?? 0),
			contentType: response.headers.get("content-type"),
		};
	}

	async delete(key: string): Promise<void> {
		const response = await this.send("delete", key, { method: "DELETE" });
		if (!response.ok && response.status !== 404) {
			throw new ObjectStoreError(`Object store delete failed with status ${response.status}`);
		}
	}
}

const DEFAULT_REGION = "us-east-1";

/**
 * `GEO_OBJECT_STORE_URL` selects the store: `file:///var/lib/geo-objects` for a
 * local directory, `https://host/bucket[/prefix]` for path-style S3 with the keys
 * from `GEO_OBJECT_STORE_ACCESS_KEY` and `GEO_OBJECT_STORE_SECRET_KEY`.
 */
export function createObjectStoreFromEnv(env: Record<string, string | undefined> = process.env): ObjectStore {
	const raw = env.GEO_OBJECT_STORE_URL?.trim();
	if (!raw) throw new ObjectStoreError("GEO_OBJECT_STORE_URL is not set");

	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new ObjectStoreError("GEO_OBJECT_STORE_URL is not a valid URL");
	}

	if (url.protocol === "file:") return new FsObjectStore(decodeURIComponent(url.pathname));

	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new ObjectStoreError("GEO_OBJECT_STORE_URL must use file:, https: or http:");
	}
	if (url.username || url.password) {
		throw new ObjectStoreError("GEO_OBJECT_STORE_URL must not embed credentials");
	}
	if (url.pathname === "/" || url.pathname === "") {
		throw new ObjectStoreError("GEO_OBJECT_STORE_URL must name a bucket in its path");
	}
	const accessKeyId = env.GEO_OBJECT_STORE_ACCESS_KEY;
	const secretAccessKey = env.GEO_OBJECT_STORE_SECRET_KEY;
	if (!accessKeyId || !secretAccessKey) {
		throw new ObjectStoreError("GEO_OBJECT_STORE_ACCESS_KEY and GEO_OBJECT_STORE_SECRET_KEY are required for S3");
	}
	return new S3ObjectStore({
		baseUrl: `${url.origin}${url.pathname}`,
		accessKeyId,
		secretAccessKey,
		region: env.GEO_OBJECT_STORE_REGION?.trim() || DEFAULT_REGION,
	});
}

let store: ObjectStore | undefined;

export function getObjectStore(): ObjectStore {
	store ??= createObjectStoreFromEnv();
	return store;
}
