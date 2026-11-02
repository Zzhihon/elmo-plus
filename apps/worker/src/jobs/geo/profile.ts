import * as Sentry from "@sentry/node";
import { applyGeoBootstrapSites } from "@workspace/geo-site-ingestion/store";
import { db } from "@workspace/lib/db/db";
import { runGeoBootstrap } from "@workspace/lib/geo/bootstrap";
import type { GeoQueue } from "./queue";
import { applyGeoBootstrapTargets } from "./sampling-bootstrap";

export const GEO_PROFILE_QUEUES: GeoQueue[] = [];

/** Bad customer config is reported, but must not keep the worker from running everyone else's jobs. */
export async function runGeoBootstrapAtStartup(): Promise<void> {
	try {
		const report = await runGeoBootstrap(db, {
			appliers: { sites: applyGeoBootstrapSites, targets: applyGeoBootstrapTargets },
		});
		if (report) console.log("GEO bootstrap applied", JSON.stringify(report.sections));
	} catch (error) {
		console.error("GEO bootstrap failed", error instanceof Error ? error.message : "unknown error");
		Sentry.captureException(error);
	}
}
