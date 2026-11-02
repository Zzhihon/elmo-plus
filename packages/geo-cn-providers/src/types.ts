import type { GeoPlatform, GeoSurfaceMode } from "@workspace/geo-domain";
import type { CaptureFailure } from "./classify";

export type SurfaceMode = GeoSurfaceMode;

export interface CaptureRequest {
	promptId: string;
	promptText: string;
	targetId: string;
	mode: SurfaceMode;
	region?: string;
	language?: string;
	runId: string;
	idempotencyKey: string;
}

export interface CaptureCitation {
	url: string;
	title?: string;
}

export interface CaptureResult {
	status: "VALID" | "PARTIAL" | "UNAVAILABLE" | "FAILED";
	responseText?: string;
	sampledAt: string;
	surfaceMode: SurfaceMode;
	providerVersion: string;
	modelVersion?: string;
	citations?: CaptureCitation[];
	evidenceUri?: string;
	errorCode?: string;
	/** Set whenever there is no usable answer; decides the run status and whether to retry. */
	failure?: CaptureFailure;
	providerTraceId?: string;
	costEstimate?: number;
	responseMetadata?: Record<string, unknown>;
	/** The provider's response body as received, kept as evidence. Never holds request headers. */
	raw?: unknown;
}

export interface CaptureCapabilities {
	available: boolean;
	mode: SurfaceMode;
	/** Why the target is or is not usable, safe to show to an administrator. */
	detail?: string;
}

export interface GeoCaptureAdapter {
	capabilities(): Promise<CaptureCapabilities>;
	capture(input: CaptureRequest): Promise<CaptureResult>;
}

export interface CaptureTarget {
	id: string;
	platform: GeoPlatform;
	surfaceMode: SurfaceMode;
	provider: string;
	modelId: string | null;
	region: string | null;
	language: string | null;
	config: unknown;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
