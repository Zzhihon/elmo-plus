import { describe, expect, it } from "vitest";
import { buildComposeYaml, buildGeoEnv } from "./compose.js";

const BASE = { dev: false, postgresMode: "docker" as const, repoRoot: "/repo", port: 1515, version: "0.9.0" };

function serviceBlock(yaml: string, name: string): string {
	const start = yaml.indexOf(`\n  ${name}:\n`);
	expect(start).toBeGreaterThan(-1);
	const rest = yaml.slice(start + 1);
	const next = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n/);
	return next === -1 ? rest : rest.slice(0, next + 1);
}

describe("buildComposeYaml with GEO", () => {
	it("adds nothing GEO-related unless asked", () => {
		const yaml = buildComposeYaml(BASE);
		expect(yaml).not.toContain("geo-objectstore");
		expect(yaml).not.toContain("clamav");
	});

	it("starts web and worker only after the private bucket exists", () => {
		const yaml = buildComposeYaml({ ...BASE, geo: { clamav: false } });
		for (const service of ["web", "worker"]) {
			const block = serviceBlock(yaml, service);
			expect(block).toContain("geo-objectstore-init:\n        condition: service_completed_successfully");
			expect(block).not.toContain("clamav");
		}
		expect(yaml).toContain("geo_objects:");
		expect(yaml).not.toContain("clamav_db");
	});

	it("keeps the object store keys out of the compose file", () => {
		const yaml = buildComposeYaml({ ...BASE, geo: { clamav: true } });
		expect(yaml).toContain("$$GEO_OBJECT_STORE_SECRET_KEY");
		expect(yaml).not.toMatch(/secretKey":"[^%]/);
	});

	it("pins every third-party GEO image to an exact tag", () => {
		const yaml = buildComposeYaml({ ...BASE, geo: { clamav: true } });
		const images = [...yaml.matchAll(/image: (\S+)/g)].map((match) => match[1]);
		for (const image of images) {
			expect(image).toMatch(/:\d+(\.\d+)+(-alpine)?$|:0\.9\.0$|:18-alpine$/);
			expect(image).not.toMatch(/:latest$/);
		}
		expect(serviceBlock(yaml, "web")).toContain("clamav:\n        condition: service_started");
	});
});

describe("buildGeoEnv", () => {
	it("points the workspace at the bundled store with fresh keys", () => {
		let n = 0;
		const env = buildGeoEnv({ clamav: false }, () => `secret-${++n}`);
		expect(env).toMatchObject({
			GEO_WORKSPACE_ENABLED: "1",
			GEO_OBJECT_STORE_URL: "http://geo-objectstore:8333/elmo-geo",
			GEO_OBJECT_STORE_ACCESS_KEY: "secret-1",
			GEO_OBJECT_STORE_SECRET_KEY: "secret-2",
		});
		expect(env.GEO_CLAMD_HOST).toBeUndefined();
	});

	it("names the ClamAV service when it is chosen", () => {
		const env = buildGeoEnv({ clamav: true }, () => "x");
		expect(env.GEO_CLAMD_HOST).toBe("clamav");
		expect(env.GEO_CLAMD_PORT).toBe("3310");
	});
});
