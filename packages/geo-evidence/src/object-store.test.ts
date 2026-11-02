import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	assertSafeObjectKey,
	createObjectStoreFromEnv,
	FsObjectStore,
	geoObjectKey,
	S3ObjectStore,
} from "./object-store";

describe("object keys", () => {
	it("rejects traversal and anything else that is not a plain relative path", () => {
		for (const key of [
			"",
			"../secret",
			"a/../../secret",
			"a/./b",
			"/etc/passwd",
			"a//b",
			"a\\..\\b",
			"a/%2e%2e/b",
			"a/b\0c",
			"a/b c",
			"x".repeat(2000),
		]) {
			expect(() => assertSafeObjectKey(key), JSON.stringify(key.slice(0, 20))).toThrow();
		}
	});

	it("files every object under its organization", () => {
		expect(geoObjectKey("org-1", "site-html", "abc.html")).toBe("geo/org-1/site-html/abc.html");
		expect(() => geoObjectKey("../org-2", "a")).toThrow();
	});
});

describe("FsObjectStore", () => {
	let root: string;
	let store: FsObjectStore;

	beforeEach(async () => {
		root = await mkdtemp(path.join(tmpdir(), "geo-object-store-"));
		store = new FsObjectStore(path.join(root, "store"));
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it("round-trips bytes and their content type", async () => {
		const put = await store.put("geo/org/a.html", "<html>开关柜</html>", { contentType: "text/html" });
		expect(put.sha256).toHaveLength(64);

		const got = await store.get("geo/org/a.html");
		expect(new TextDecoder().decode(got?.body)).toBe("<html>开关柜</html>");
		expect(got?.contentType).toBe("text/html");
		expect(await store.head("geo/org/a.html")).toEqual({ size: put.size, contentType: "text/html" });
	});

	it("answers null for what is not there and forgets what was deleted", async () => {
		expect(await store.get("geo/org/none")).toBeNull();
		expect(await store.head("geo/org/none")).toBeNull();
		await store.put("geo/org/a", "x");
		await store.delete("geo/org/a");
		expect(await store.get("geo/org/a")).toBeNull();
	});

	it("will not follow a symlink out of its root", async () => {
		const outside = path.join(root, "outside");
		await new FsObjectStore(outside).put("secret", "x");
		await new FsObjectStore(path.join(root, "store")).put("geo/placeholder", "x");
		await symlink(outside, path.join(root, "store", "link"));
		await expect(store.get("link/secret")).rejects.toThrow("escapes the store root");
		await expect(store.put("link/new", "x")).rejects.toThrow("escapes the store root");
	});
});

describe("createObjectStoreFromEnv", () => {
	const s3Env = {
		GEO_OBJECT_STORE_URL: "https://s3.example.test/evidence",
		GEO_OBJECT_STORE_ACCESS_KEY: "key",
		GEO_OBJECT_STORE_SECRET_KEY: "secret",
	};

	it("chooses the store from the URL", () => {
		expect(createObjectStoreFromEnv({ GEO_OBJECT_STORE_URL: "file:///tmp/geo" })).toBeInstanceOf(FsObjectStore);
		expect(createObjectStoreFromEnv(s3Env)).toBeInstanceOf(S3ObjectStore);
	});

	it("refuses a misconfiguration without echoing it", () => {
		expect(() => createObjectStoreFromEnv({})).toThrow("not set");
		expect(() => createObjectStoreFromEnv({ ...s3Env, GEO_OBJECT_STORE_SECRET_KEY: "" })).toThrow("required");
		expect(() => createObjectStoreFromEnv({ ...s3Env, GEO_OBJECT_STORE_URL: "https://s3.example.test/" })).toThrow(
			"bucket",
		);
		const embedded = "https://key:hunter2@s3.example.test/evidence";
		expect(() => createObjectStoreFromEnv({ ...s3Env, GEO_OBJECT_STORE_URL: embedded })).toThrow(
			expect.not.stringContaining("hunter2"),
		);
	});
});
