import type { GeoBatchStatus, GeoObservationStatus, GeoRunStatus } from "./enums";
import { GEO_QUEUE, samplingRunIdempotencyKey } from "./queues";

/** Payload `{ organizationId, observationId }`. Sent after an observation with an answer is stored. */
export const GEO_EVALUATE_OBSERVATION_QUEUE = GEO_QUEUE.evaluation;

export interface GeoEvaluateObservationJob {
	organizationId: string;
	observationId: string;
}

export const GEO_TERMINAL_RUN_STATUSES = [
	"VALID",
	"PARTIAL",
	"UNAVAILABLE",
	"NEEDS_MANUAL",
	"FAILED",
	"RATE_LIMITED",
	"TIMEOUT",
	"CAPTCHA",
	"NETWORK_ERROR",
] as const satisfies readonly GeoRunStatus[];

export function isTerminalRunStatus(status: GeoRunStatus): boolean {
	return (GEO_TERMINAL_RUN_STATUSES as readonly GeoRunStatus[]).includes(status);
}

/**
 * Only a complete answer enters a rate's denominator. A failure, a block, a rate limit
 * or a truncated answer says nothing about whether the brand would have been named,
 * so counting it would turn an outage into a fake "not mentioned".
 */
export const GEO_DENOMINATOR_STATUSES = ["VALID"] as const satisfies readonly GeoObservationStatus[];

/** Anything with answer text can be evaluated and reviewed, even if it stays out of the rates. */
export const GEO_EVALUABLE_OBSERVATION_STATUSES = [
	"VALID",
	"PARTIAL",
] as const satisfies readonly GeoObservationStatus[];

export function countsAsValidSample(status: GeoObservationStatus | GeoRunStatus): boolean {
	return (GEO_DENOMINATOR_STATUSES as readonly string[]).includes(status);
}

export function isEvaluableObservation(status: GeoObservationStatus): boolean {
	return (GEO_EVALUABLE_OBSERVATION_STATUSES as readonly string[]).includes(status);
}

/** One planned sample: retries and explicit re-samples of it share this key. */
export function samplingSlotKey(input: {
	batchId: string;
	promptId: string;
	targetId: string;
	repeatIndex: number;
}): string {
	return samplingRunIdempotencyKey(input);
}

export interface GeoSlotSample {
	slotKey: string;
	status: GeoObservationStatus;
	sampledAt: Date | string;
}

/**
 * Collapses re-samples so a slot contributes at most once: its latest valid sample
 * if it has one, otherwise its latest sample (which then stays out of the denominator).
 */
export function pickCountedSamples<T extends GeoSlotSample>(samples: readonly T[]): T[] {
	const bySlot = new Map<string, T>();
	for (const sample of samples) {
		const current = bySlot.get(sample.slotKey);
		if (!current || preferSample(sample, current)) bySlot.set(sample.slotKey, sample);
	}
	return [...bySlot.values()];
}

function preferSample(candidate: GeoSlotSample, current: GeoSlotSample): boolean {
	const candidateValid = countsAsValidSample(candidate.status);
	const currentValid = countsAsValidSample(current.status);
	if (candidateValid !== currentValid) return candidateValid;
	return new Date(candidate.sampledAt).getTime() > new Date(current.sampledAt).getTime();
}

export interface GeoBatchCounts {
	planned: number;
	valid: number;
	partial: number;
	unavailable: number;
	failed: number;
	pending: number;
}

/** Buckets mirror the batch columns: blocked or unsupported is "unavailable", everything that broke is "failed". */
export function runStatusBucket(status: GeoRunStatus): keyof Omit<GeoBatchCounts, "planned"> {
	switch (status) {
		case "VALID":
			return "valid";
		case "PARTIAL":
			return "partial";
		case "UNAVAILABLE":
		case "NEEDS_MANUAL":
		case "CAPTCHA":
			return "unavailable";
		case "FAILED":
		case "RATE_LIMITED":
		case "TIMEOUT":
		case "NETWORK_ERROR":
			return "failed";
		case "PLANNED":
		case "RUNNING":
			return "pending";
	}
}

/** `statuses` holds one entry per slot, already collapsed with the same rule as `pickCountedSamples`. */
export function summarizeBatch(statuses: readonly GeoRunStatus[]): GeoBatchCounts {
	const counts: GeoBatchCounts = {
		planned: statuses.length,
		valid: 0,
		partial: 0,
		unavailable: 0,
		failed: 0,
		pending: 0,
	};
	for (const status of statuses) counts[runStatusBucket(status)] += 1;
	return counts;
}

/** A paused batch stays paused until someone resumes it, whatever its runs are doing. */
export function deriveBatchStatus(current: GeoBatchStatus, counts: GeoBatchCounts): GeoBatchStatus {
	if (current === "PAUSED" || current === "CANCELLED") return current;
	if (counts.planned === 0) return "COMPLETED";
	if (counts.pending > 0) return current === "PLANNED" && counts.pending === counts.planned ? "PLANNED" : "RUNNING";
	if (counts.valid === counts.planned) return "COMPLETED";
	if (counts.valid + counts.partial > 0) return "PARTIAL";
	return "FAILED";
}

const OBJECT_NAME = /^[A-Za-z0-9._-]+$/;
const UPLOAD_NAME = /^[0-9a-f]{64}\.[a-z0-9]{2,5}$/;

export interface GeoObservationEvidencePointer {
	organizationId: string;
	runId: string | null;
	importBatchId: string | null;
	evidenceUri: string | null;
}

/**
 * Which kind of object this observation may own: the raw response its own run stored, or
 * a file uploaded for its import (the caller still has to find that upload record). Any
 * other pointer is only text, however much it looks like a key, so nothing ever reads or
 * deletes knowledge originals, reports or snapshots through an observation.
 */
export function observationEvidenceOwnership(pointer: GeoObservationEvidencePointer): "RUN" | "UPLOAD" | null {
	const { organizationId, runId, importBatchId, evidenceUri } = pointer;
	if (!evidenceUri) return null;
	if (runId) {
		const prefix = `geo/${organizationId}/observations/${runId}/`;
		if (!evidenceUri.startsWith(prefix)) return null;
		return OBJECT_NAME.test(evidenceUri.slice(prefix.length)) ? "RUN" : null;
	}
	const prefix = `geo/${organizationId}/evidence/`;
	if (!importBatchId || !evidenceUri.startsWith(prefix)) return null;
	return UPLOAD_NAME.test(evidenceUri.slice(prefix.length)) ? "UPLOAD" : null;
}
