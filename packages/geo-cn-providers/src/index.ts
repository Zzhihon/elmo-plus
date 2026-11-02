export { createCaptureAdapter, sourceMethodVersion } from "./adapters";
export { type BootstrapTarget, parseBootstrapTargets } from "./bootstrap";
export {
	CAPTURE_FAILURE_KINDS,
	type CaptureFailure,
	type CaptureFailureKind,
	captureFailure,
	classifyHttpFailure,
	classifyThrown,
	failureRunStatus,
	failureTripsBreaker,
	parseRetryAfter,
	type TerminalRunStatus,
} from "./classify";
export {
	type ConfigResult,
	estimatedCostPerRun,
	findSecretKeys,
	type LiveSurfaceConfig,
	type ModelApiConfig,
	parseLiveSurfaceConfig,
	parseModelApiConfig,
	targetEndpointHosts,
	targetEndpointUrls,
	validateTargetConfig,
} from "./config";
export { isHttpUrl } from "./http";
export { LIVE_SURFACE_PROVIDER_VERSION, LicensedHttpAdapter } from "./live-surface";
export {
	isUploadedEvidenceRef,
	MANUAL_IMPORT_COLUMNS,
	MANUAL_IMPORT_MAX_ROWS,
	MANUAL_SOURCE_METHOD_VERSION,
	ManualEvidenceAdapter,
	type ManualImportRow,
	type ManualImportRowInput,
	type ManualRowError,
	manualImportErrorCode,
	manualImportFingerprint,
	normalizeCsvRecord,
	parsePlatform,
	parseSampledAt,
	validateManualRows,
} from "./manual";
export { MODEL_API_PROVIDER_VERSION, ModelApiAdapter } from "./model-api";
export { enabledSamplingPlatforms, GEO_SAMPLING_PLATFORMS_ENV, isSamplingPlatformEnabled } from "./platforms";
export {
	type AvailableWindow,
	type BreakerGate,
	type BreakerSnapshot,
	backoffDelayMs,
	breakerAfter,
	breakerGate,
	type CaptureOutcome,
	checkQuota,
	DEFAULT_RETRY_POLICY,
	decideRetry,
	isWithinWindow,
	msUntilWindowOpens,
	parseAvailableWindow,
	type QuotaDecision,
	type QuotaLimits,
	type QuotaUsage,
	type RetryDecision,
	type RetryPolicy,
	resolveRetryPolicy,
} from "./policy";
export { describeText, redactForLog, redactSecrets, safeErrorDetail } from "./redact";
export type {
	CaptureCapabilities,
	CaptureCitation,
	CaptureRequest,
	CaptureResult,
	CaptureTarget,
	FetchLike,
	GeoCaptureAdapter,
	SurfaceMode,
} from "./types";
