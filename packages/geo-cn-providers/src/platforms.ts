import { GEO_PLATFORMS, type GeoPlatform } from "@workspace/geo-domain";

export const GEO_SAMPLING_PLATFORMS_ENV = "GEO_SAMPLING_PLATFORMS";

/**
 * The deployment-wide switch per platform. Unset means every platform may be sampled;
 * `none` switches automatic sampling off everywhere. Manual import is never affected.
 */
export function enabledSamplingPlatforms(
	env: Record<string, string | undefined> = process.env,
): ReadonlySet<GeoPlatform> {
	const raw = env[GEO_SAMPLING_PLATFORMS_ENV]?.trim();
	if (!raw) return new Set(GEO_PLATFORMS);
	if (raw.toLowerCase() === "none") return new Set();
	const listed = raw.split(",").map((item) => item.trim().toLowerCase());
	return new Set(GEO_PLATFORMS.filter((platform) => listed.includes(platform)));
}

export function isSamplingPlatformEnabled(platform: GeoPlatform, env?: Record<string, string | undefined>): boolean {
	return enabledSamplingPlatforms(env).has(platform);
}
