import { randomUUID } from "node:crypto";
import { parseBootstrapTargets } from "@workspace/geo-cn-providers";
import { GeoError, geoSystemPrincipal } from "@workspace/geo-domain";
import type { DbConnection } from "@workspace/lib/db/db-connection";
import { geoSamplingTargets } from "@workspace/lib/db/schema";
import { writeGeoAudit } from "@workspace/lib/geo/audit";

/**
 * Applies the `targets` section of the bootstrap file. A target is identified by its
 * `key`; one that already exists is left as it is, because an administrator may have
 * changed it since, so running this again never overwrites or duplicates anything.
 * Every target arrives UNVERIFIED whatever the file says. A section with any error
 * throws, like the other sections, so a broken file is never reported as imported.
 */
export async function applyGeoBootstrapTargets(
	db: DbConnection,
	organizationId: string,
	section: unknown,
): Promise<{ created: number; skipped: number }> {
	const { targets, errors } = parseBootstrapTargets(section);
	if (errors.length) throw new GeoError("VALIDATION_ERROR", `引导配置中的采样目标无效：${errors.join("；")}`);
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
	return { created, skipped: targets.length - created };
}
