import fs from "node:fs/promises";
import path from "node:path";
import { refreshHeaderVersion, renderedByHeader, repinImages } from "./compose-pin.js";
import type { PostgresMode } from "./config.js";
import { indentBlock } from "./util.js";

// Rewrites `elmohq/elmo-*:<tag>` image tags in place, preserving any manual
// edits the user made to the compose file, then refreshes the version header.
export async function repinComposeImages(composePath: string, version: string): Promise<void> {
	const contents = await fs.readFile(composePath, "utf8");
	await fs.writeFile(composePath, refreshHeaderVersion(repinImages(contents, version), version), "utf8");
}

export async function refreshRenderedVersion(filePath: string, version: string): Promise<void> {
	try {
		const contents = await fs.readFile(filePath, "utf8");
		await fs.writeFile(filePath, refreshHeaderVersion(contents, version), "utf8");
	} catch {
		// File is optional (e.g. .env may be absent in some setups).
	}
}

export function buildComposeYaml(options: {
	dev: boolean;
	postgresMode: PostgresMode;
	repoRoot: string;
	dockerDir?: string;
	port: number;
	version: string;
	geo?: GeoComposeOptions;
}): string {
	const services: string[] = [];
	const volumes = new Set<string>();

	const dependsOnWeb: string[] = [];
	const dependsOnWorker: string[] = [];

	const dependencyConditions: Record<string, string> = {
		postgres: "service_healthy",
		"db-migrate": "service_completed_successfully",
		[GEO_OBJECT_STORE_SERVICE]: "service_healthy",
		[GEO_OBJECT_STORE_INIT_SERVICE]: "service_completed_successfully",
		// Signatures download on first start; uploads fail closed until clamd answers.
		[GEO_CLAMAV_SERVICE]: "service_started",
	};

	const dockerfilePath = options.dockerDir
		? path.relative(options.repoRoot, path.join(options.dockerDir, "Dockerfile"))
		: "docker/Dockerfile";

	if (options.postgresMode === "docker") {
		services.push(buildPostgresService());
		services.push(
			buildDbMigrateService({
				dev: options.dev,
				dockerfilePath,
				repoRoot: options.repoRoot,
				version: options.version,
			}),
		);
		dependsOnWeb.push("db-migrate");
		dependsOnWorker.push("db-migrate");
		volumes.add("postgres_data");
	}

	if (options.geo) {
		services.push(buildGeoObjectStoreService(), buildGeoObjectStoreInitService());
		volumes.add("geo_objects");
		const geoDependencies = [GEO_OBJECT_STORE_INIT_SERVICE];
		if (options.geo.clamav) {
			services.push(buildClamavService());
			volumes.add("clamav_db");
			geoDependencies.push(GEO_CLAMAV_SERVICE);
		}
		dependsOnWeb.push(...geoDependencies);
		dependsOnWorker.push(...geoDependencies);
	}

	services.push(
		buildWebService({
			dev: options.dev,
			dependsOn: dependsOnWeb,
			dependencyConditions,
			repoRoot: options.repoRoot,
			dockerfilePath,
			port: options.port,
			version: options.version,
		}),
	);
	services.push(
		buildWorkerService({
			dev: options.dev,
			dependsOn: dependsOnWorker,
			dependencyConditions,
			repoRoot: options.repoRoot,
			dockerfilePath,
			version: options.version,
		}),
	);

	const lines = [renderedByHeader(options.version), "", "name: elmo", "", "services:"];
	lines.push(...services.map((service) => indentBlock(service, 2)));

	if (volumes.size > 0) {
		lines.push("", "volumes:");
		for (const volume of volumes) {
			lines.push(`  ${volume}:`);
		}
	}

	return `${lines.join("\n")}\n`;
}

export interface GeoComposeOptions {
	clamav: boolean;
}

// Pinned on purpose: `elmo upgrade` re-pins only elmohq images, so these move
// only when someone edits them here.
export const GEO_OBJECT_STORE_IMAGE = "chrislusf/seaweedfs:3.80";
export const GEO_OBJECT_STORE_INIT_IMAGE = "rclone/rclone:1.68.2";
export const GEO_CLAMAV_IMAGE = "clamav/clamav:1.4.1";

export const GEO_OBJECT_STORE_SERVICE = "geo-objectstore";
export const GEO_OBJECT_STORE_INIT_SERVICE = "geo-objectstore-init";
export const GEO_CLAMAV_SERVICE = "clamav";
export const GEO_BUCKET = "elmo-geo";

/** The GEO variables `elmo init --geo` writes; the keys are fresh for every install. */
export function buildGeoEnv(options: GeoComposeOptions, randomSecret: () => string): Record<string, string> {
	const env: Record<string, string> = {
		GEO_WORKSPACE_ENABLED: "1",
		GEO_OBJECT_STORE_URL: `http://${GEO_OBJECT_STORE_SERVICE}:8333/${GEO_BUCKET}`,
		GEO_OBJECT_STORE_ACCESS_KEY: randomSecret(),
		GEO_OBJECT_STORE_SECRET_KEY: randomSecret(),
		GEO_OBJECT_STORE_REGION: "us-east-1",
	};
	if (options.clamav) {
		env.GEO_CLAMD_HOST = GEO_CLAMAV_SERVICE;
		env.GEO_CLAMD_PORT = "3310";
	}
	return env;
}

/**
 * The S3 identity is written from the environment at start, so the keys live
 * only in `.env`. With no anonymous identity configured every bucket is private.
 */
function buildGeoObjectStoreService(): string {
	return [
		`${GEO_OBJECT_STORE_SERVICE}:`,
		`  image: ${GEO_OBJECT_STORE_IMAGE}`,
		"  env_file:",
		"    - path: .env",
		"      required: true",
		'  entrypoint: ["/bin/sh", "-c"]',
		"  command:",
		"    - >-",
		`      printf '{"identities":[{"name":"elmo","credentials":[{"accessKey":"%s","secretKey":"%s"}],"actions":["Admin","Read","List","Tagging","Write"]}]}'`,
		'      "$$GEO_OBJECT_STORE_ACCESS_KEY" "$$GEO_OBJECT_STORE_SECRET_KEY" > /tmp/s3.json',
		"      && exec weed server -dir=/data -s3 -s3.port=8333 -s3.config=/tmp/s3.json",
		"  volumes:",
		"    - geo_objects:/data",
		"  healthcheck:",
		'    test: ["CMD-SHELL", "wget -q -O /dev/null http://127.0.0.1:9333/cluster/status || exit 1"]',
		"    interval: 10s",
		"    timeout: 5s",
		"    retries: 6",
		"    start_period: 20s",
	].join("\n");
}

/** Creating an existing bucket is a no-op for rclone, so this is safe on every start. */
function buildGeoObjectStoreInitService(): string {
	return [
		`${GEO_OBJECT_STORE_INIT_SERVICE}:`,
		`  image: ${GEO_OBJECT_STORE_INIT_IMAGE}`,
		"  env_file:",
		"    - path: .env",
		"      required: true",
		'  entrypoint: ["/bin/sh", "-c"]',
		"  command:",
		"    - >-",
		"      RCLONE_CONFIG_GEO_TYPE=s3 RCLONE_CONFIG_GEO_PROVIDER=SeaweedFS",
		`      RCLONE_CONFIG_GEO_ENDPOINT=http://${GEO_OBJECT_STORE_SERVICE}:8333`,
		'      RCLONE_CONFIG_GEO_ACCESS_KEY_ID="$$GEO_OBJECT_STORE_ACCESS_KEY"',
		'      RCLONE_CONFIG_GEO_SECRET_ACCESS_KEY="$$GEO_OBJECT_STORE_SECRET_KEY"',
		`      rclone mkdir geo:${GEO_BUCKET}`,
		"  depends_on:",
		`    ${GEO_OBJECT_STORE_SERVICE}:`,
		"      condition: service_healthy",
	].join("\n");
}

function buildClamavService(): string {
	return [
		`${GEO_CLAMAV_SERVICE}:`,
		`  image: ${GEO_CLAMAV_IMAGE}`,
		"  volumes:",
		"    - clamav_db:/var/lib/clamav",
		"  healthcheck:",
		'    test: ["CMD", "clamdcheck.sh"]',
		"    interval: 60s",
		"    timeout: 10s",
		"    retries: 3",
		"    start_period: 300s",
	].join("\n");
}

function buildPostgresService(): string {
	return [
		"postgres:",
		"  image: postgres:18-alpine",
		"  environment:",
		"    POSTGRES_USER: postgres",
		"    POSTGRES_PASSWORD: postgres",
		"    POSTGRES_DB: elmo",
		"  volumes:",
		// PostgreSQL 18 puts PGDATA in a version-specific child directory and
		// declares its volume at this parent. Mounting the child path can silently
		// place the cluster in an anonymous volume that disappears on recreation.
		"    - postgres_data:/var/lib/postgresql",
		"  ports:",
		'    - "5432:5432"',
		"  healthcheck:",
		'    test: ["CMD-SHELL", "pg_isready -U postgres"]',
		"    interval: 5s",
		"    timeout: 5s",
		"    retries: 5",
		"    start_period: 30s",
	].join("\n");
}

function buildDbMigrateService(options: {
	dev: boolean;
	dockerfilePath: string;
	repoRoot: string;
	version: string;
}): string {
	const lines = ["db-migrate:"];
	if (options.dev) {
		lines.push(
			"  build:",
			`    context: ${options.repoRoot}`,
			`    dockerfile: ${options.dockerfilePath}`,
			"    target: migrate",
		);
	} else {
		lines.push(`  image: elmohq/elmo-db-migrate:${options.version}`);
	}

	lines.push(
		"  environment:",
		"    - DATABASE_URL=postgres://postgres:postgres@postgres:5432/elmo",
		"  depends_on:",
		"    postgres:",
		"      condition: service_healthy",
	);

	return lines.join("\n");
}

function buildWebService(options: {
	dev: boolean;
	dependsOn: string[];
	dependencyConditions: Record<string, string>;
	repoRoot: string;
	dockerfilePath: string;
	port: number;
	version: string;
}): string {
	const lines = ["web:"];
	if (options.dev) {
		lines.push(
			"  build:",
			`    context: ${options.repoRoot}`,
			`    dockerfile: ${options.dockerfilePath}`,
			"    target: web",
		);
	} else {
		lines.push(`  image: elmohq/elmo-web:${options.version}`);
	}

	lines.push("  env_file:", "    - path: .env", "      required: true", "  ports:", `    - "${options.port}:3000"`);

	if (options.dependsOn.length > 0) {
		lines.push("  depends_on:");
		for (const service of options.dependsOn) {
			const condition = options.dependencyConditions[service] ?? "service_started";
			lines.push(`    ${service}:`, `      condition: ${condition}`);
		}
	}

	return lines.join("\n");
}

function buildWorkerService(options: {
	dev: boolean;
	dependsOn: string[];
	dependencyConditions: Record<string, string>;
	repoRoot: string;
	dockerfilePath: string;
	version: string;
}): string {
	const lines = ["worker:"];
	if (options.dev) {
		lines.push(
			"  build:",
			`    context: ${options.repoRoot}`,
			`    dockerfile: ${options.dockerfilePath}`,
			"    target: worker",
		);
	} else {
		lines.push(`  image: elmohq/elmo-worker:${options.version}`);
	}

	lines.push("  env_file:", "    - path: .env", "      required: true");

	// On SIGTERM the worker gives pg-boss 30s to finish in-flight jobs, then
	// flushes telemetry. Compose's 10s default would SIGKILL it partway through
	// an evaluation, burning the provider call that job already paid for.
	lines.push("  stop_grace_period: 35s");

	if (options.dependsOn.length > 0) {
		lines.push("  depends_on:");
		for (const service of options.dependsOn) {
			const condition = options.dependencyConditions[service] ?? "service_started";
			lines.push(`    ${service}:`, `      condition: ${condition}`);
		}
	}

	return lines.join("\n");
}
