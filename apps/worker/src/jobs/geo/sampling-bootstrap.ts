import { randomUUID } from "node:crypto";
import { parseBootstrapTargets } from "@workspace/geo-cn-providers";
import { geoSystemPrincipal } from "@workspace/geo-domain";
import type { DbConnection } from "@workspace/lib/db/db-connection";
import { geoSamplingTargets } from "@workspace/lib/db/schema";
import { writeGeoAudit } from "@workspace/lib/geo/audit";

/**
 * Applies the `targets` section of the bootstrap file. A target is identified by its
 * `key`; one that already exists is left as it is, because an administrator may have
 * changed it since, so running this again never overwrites or duplicates anything.
 * Every target arrives UNVERIFIED whatever the file says.
 */
export async function applyGeoBootstrapTargets(
	db: DbConnection,
	organizationId: string,
	section: unknown,
): Promise<{ created: number; skipped: number; errors: string[] }> {
	const { targets, errors } = parseBootstrapTargets(section);
	if (errors.length) return { created: 0, skipped: 0, errors };
	const principal = geoSystemPrincipal(organizationId, "bootstrap", randomUUID());
	let created = 0;
	for (const target of targets) {
		const [row] = await db
			.insert(geoSamplingTargets)
			.values({
				organizationId,
				bootstrapKey: target.key,
				platform: target.platform,
				surfaceMode: target.surfaceMode,
				provider: target.provider,
				modelId: target.modelId,
				region: target.region,
				language: target.language,
				config: target.config,
				credentialRef: target.credentialRef,
				availableWindow: target.availableWindow,
				maxConcurrency: target.maxConcurrency,
				perMinuteQuota: target.perMinuteQuota,
				perDayQuota: target.perDayQuota,
				retryPolicy: target.retryPolicy,
				costBudget: target.costBudget,
				enabled: target.enabled,
				verificationStatus: "UNVERIFIED",
				verificationNote: target.verificationNote,
				createdBy: principal.actorId,
			})
			.onConflictDoNothing({ target: [geoSamplingTargets.organizationId, geoSamplingTargets.bootstrapKey] })
			.returning();
		if (!row) continue;
		created += 1;
		await writeGeoAudit(db, {
			principal,
			action: "target.bootstrap",
			entityType: "sampling_target",
			entityId: row.id,
			after: row,
			metadata: { bootstrapKey: target.key },
		});
	}
	return { created, skipped: targets.length - created, errors: [] };
}
