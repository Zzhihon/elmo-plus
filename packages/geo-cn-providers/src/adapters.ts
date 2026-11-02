import { captureFailure } from "./classify";
import { parseLiveSurfaceConfig, parseModelApiConfig } from "./config";
import { LicensedHttpAdapter } from "./live-surface";
import { ManualEvidenceAdapter } from "./manual";
import { ModelApiAdapter } from "./model-api";
import type { CaptureCapabilities, CaptureResult, CaptureTarget, FetchLike, GeoCaptureAdapter } from "./types";

/** Stands in for a target whose configuration does not parse, so the run ends as unavailable rather than crashing. */
class MisconfiguredAdapter implements GeoCaptureAdapter {
	constructor(
		private readonly target: CaptureTarget,
		private readonly errors: string[],
	) {}

	async capabilities(): Promise<CaptureCapabilities> {
		return { available: false, mode: this.target.surfaceMode, detail: `配置不完整：${this.errors.join("；")}` };
	}

	async capture(): Promise<CaptureResult> {
		const failure = captureFailure("CONFIG", "CONFIG_INVALID", "采样目标配置不完整");
		return {
			status: "UNAVAILABLE",
			sampledAt: new Date().toISOString(),
			surfaceMode: this.target.surfaceMode,
			providerVersion: "misconfigured",
			failure,
			errorCode: failure.code,
		};
	}
}

export function createCaptureAdapter(
	target: CaptureTarget,
	options: { credential: string | null; timeoutMs: number; fetch?: FetchLike; now?: () => Date },
): GeoCaptureAdapter {
	if (target.surfaceMode === "MANUAL_EVIDENCE") return new ManualEvidenceAdapter();
	if (target.surfaceMode === "MODEL_API") {
		const parsed = parseModelApiConfig(target.config, target.modelId);
		return parsed.ok
			? new ModelApiAdapter({ ...options, config: parsed.value })
			: new MisconfiguredAdapter(target, parsed.errors);
	}
	const parsed = parseLiveSurfaceConfig(target.config);
	return parsed.ok
		? new LicensedHttpAdapter({ ...options, config: parsed.value, platform: target.platform })
		: new MisconfiguredAdapter(target, parsed.errors);
}

/** Recorded on each observation so a change in how answers were captured shows up as a break in the series. */
export function sourceMethodVersion(
	target: Pick<CaptureTarget, "surfaceMode" | "provider">,
	providerVersion: string,
): string {
	return `${target.surfaceMode.toLowerCase()}:${target.provider}:${providerVersion}`.slice(0, 200);
}
