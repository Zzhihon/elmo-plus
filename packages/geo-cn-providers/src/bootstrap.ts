import {
	GEO_PLATFORMS,
	GEO_SURFACE_MODES,
	type GeoPlatform,
	type GeoSurfaceMode,
	isGeoCredentialRef,
} from "@workspace/geo-domain";
import { findSecretKeys } from "./config";
import { parseAvailableWindow } from "./policy";

export interface BootstrapTarget {
	key: string;
	platform: GeoPlatform;
	surfaceMode: GeoSurfaceMode;
	provider: string;
	modelId: string | null;
	region: string | null;
	language: string;
	config: Record<string, unknown>;
	credentialRef: string | null;
	availableWindow: unknown;
	maxConcurrency: number;
	perMinuteQuota: number | null;
	perDayQuota: number | null;
	retryPolicy: Record<string, unknown> | null;
	costBudget: string | null;
	enabled: boolean;
	verificationNote: string | null;
}

function positiveInt(value: unknown): number | null {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function text(value: unknown, max = 200): string | null {
	return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

function plainObject(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function oneOf<T extends string>(values: readonly T[], value: unknown): T | null {
	return (values as readonly unknown[]).includes(value) ? (value as T) : null;
}

function costBudgetOf(value: unknown): string | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value.toFixed(4) : null;
}

function identityErrors(at: string, item: Record<string, unknown>, seen: ReadonlySet<string>): string[] {
	const key = text(item.key, 100);
	return [
		...(!key ? [`${at}.key 必填`] : seen.has(key) ? [`${at}.key 重复：${key}`] : []),
		...(oneOf(GEO_PLATFORMS, item.platform) ? [] : [`${at}.platform 无效`]),
		...(oneOf(GEO_SURFACE_MODES, item.surfaceMode) ? [] : [`${at}.surfaceMode 无效`]),
		...(text(item.provider, 100) ? [] : [`${at}.provider 必填`]),
	];
}

function settingErrors(at: string, item: Record<string, unknown>): string[] {
	const credentialRef = text(item.credentialRef, 200);
	const window = parseAvailableWindow(item.availableWindow);
	return [
		...findSecretKeys(plainObject(item.config) ?? {}, `${at}.config`).map((path) => `${path} 不能在配置文件中出现密钥`),
		...(credentialRef && !isGeoCredentialRef(credentialRef)
			? [`${at}.credentialRef 必须是工作台设置中管理的密钥引用名（大写字母、数字和下划线）`]
			: []),
		...(window.ok ? [] : [`${at}.availableWindow：${window.error}`]),
	];
}

function toTarget(item: Record<string, unknown>): BootstrapTarget {
	const window = parseAvailableWindow(item.availableWindow);
	return {
		key: text(item.key, 100) as string,
		platform: item.platform as GeoPlatform,
		surfaceMode: item.surfaceMode as GeoSurfaceMode,
		provider: text(item.provider, 100) as string,
		modelId: text(item.modelId),
		region: text(item.region, 50),
		language: text(item.language, 20) ?? "zh-CN",
		config: plainObject(item.config) ?? {},
		credentialRef: text(item.credentialRef, 200),
		availableWindow: window.ok ? window.value : null,
		maxConcurrency: positiveInt(item.maxConcurrency) ?? 1,
		perMinuteQuota: positiveInt(item.perMinuteQuota),
		perDayQuota: positiveInt(item.perDayQuota),
		retryPolicy: plainObject(item.retryPolicy),
		costBudget: costBudgetOf(item.costBudget),
		enabled: item.enabled === true,
		verificationNote: text(item.verificationNote, 1000),
	};
}

/**
 * Reads the `targets` section of the bootstrap file. A verification status in the file
 * is ignored on purpose: only an administrator, through the audited action, can mark a
 * target as verified. A credential may only appear as a reference into the secrets store.
 */
export function parseBootstrapTargets(section: unknown): { targets: BootstrapTarget[]; errors: string[] } {
	if (!Array.isArray(section)) return { targets: [], errors: ["targets 必须是数组"] };
	const errors: string[] = [];
	const targets: BootstrapTarget[] = [];
	const keys = new Set<string>();
	section.forEach((raw, index) => {
		const at = `targets[${index}]`;
		const item = plainObject(raw) ?? {};
		const local = [...identityErrors(at, item, keys), ...settingErrors(at, item)];
		if (local.length) {
			errors.push(...local);
			return;
		}
		const target = toTarget(item);
		keys.add(target.key);
		targets.push(target);
	});
	return { targets, errors };
}
