import {
	GEO_ASSERTION_STATUS_LABELS,
	GEO_BATCH_STATUS_LABELS,
	GEO_EVALUATION_REVIEW_LABELS,
	GEO_PROMPT_STATUS_LABELS,
	GEO_RUN_STATUS_LABELS,
	GEO_TASK_STATE_LABELS,
	GEO_VERIFICATION_LABELS,
	type GeoAssertionStatus,
	type GeoBatchStatus,
	type GeoEvaluationReviewStatus,
	type GeoPromptStatus,
	type GeoRunStatus,
	type GeoTaskState,
	type GeoVerificationStatus,
} from "@workspace/geo-domain";
import { Badge } from "@workspace/ui/components/badge";
import { cn } from "@workspace/ui/lib/utils";

export type GeoBadgeTone = "neutral" | "info" | "success" | "warning" | "danger";

const TONE_CLASSES: Record<GeoBadgeTone, string> = {
	neutral: "border-border bg-muted text-muted-foreground",
	info: "border-blue-200 bg-blue-50 text-blue-700",
	success: "border-emerald-200 bg-emerald-50 text-emerald-700",
	warning: "border-amber-200 bg-amber-50 text-amber-800",
	danger: "border-red-200 bg-red-50 text-red-700",
};

export function GeoStatusBadge({
	label,
	tone = "neutral",
	className,
}: {
	label: string;
	tone?: GeoBadgeTone;
	className?: string;
}) {
	return (
		<Badge variant="outline" className={cn(TONE_CLASSES[tone], className)}>
			{label}
		</Badge>
	);
}

const TASK_TONES: Record<GeoTaskState, GeoBadgeTone> = {
	PENDING_ANALYSIS: "neutral",
	PENDING_ASSIGNMENT: "neutral",
	IN_PROGRESS: "info",
	PENDING_TECH_REVIEW: "warning",
	PENDING_MARKETING_REVIEW: "warning",
	PENDING_PUBLISH: "info",
	PUBLISHED: "info",
	PENDING_RETEST: "warning",
	VERIFIED: "success",
	REJECTED: "danger",
	PAUSED: "neutral",
	CANCELLED: "neutral",
};

export function GeoTaskStateBadge({ state }: { state: GeoTaskState }) {
	return <GeoStatusBadge label={GEO_TASK_STATE_LABELS[state]} tone={TASK_TONES[state]} />;
}

const ASSERTION_TONES: Record<GeoAssertionStatus, GeoBadgeTone> = {
	DISCOVERED: "neutral",
	PARSED: "neutral",
	PENDING_REVIEW: "warning",
	APPROVED: "success",
	REJECTED: "danger",
	NEEDS_EVIDENCE: "warning",
	SUPERSEDED: "neutral",
	SOURCE_UNAVAILABLE: "danger",
};

export function GeoAssertionStatusBadge({ status }: { status: GeoAssertionStatus }) {
	return <GeoStatusBadge label={GEO_ASSERTION_STATUS_LABELS[status]} tone={ASSERTION_TONES[status]} />;
}

const PROMPT_TONES: Record<GeoPromptStatus, GeoBadgeTone> = {
	DRAFT: "neutral",
	IN_REVIEW: "warning",
	BASELINE: "info",
	FROZEN: "success",
	REJECTED: "danger",
};

export function GeoPromptStatusBadge({ status }: { status: GeoPromptStatus }) {
	return <GeoStatusBadge label={GEO_PROMPT_STATUS_LABELS[status]} tone={PROMPT_TONES[status]} />;
}

const BATCH_TONES: Record<GeoBatchStatus, GeoBadgeTone> = {
	PLANNED: "neutral",
	RUNNING: "info",
	PAUSED: "neutral",
	COMPLETED: "success",
	PARTIAL: "warning",
	FAILED: "danger",
	CANCELLED: "neutral",
};

export function GeoBatchStatusBadge({ status }: { status: GeoBatchStatus }) {
	return <GeoStatusBadge label={GEO_BATCH_STATUS_LABELS[status]} tone={BATCH_TONES[status]} />;
}

const RUN_TONES: Record<GeoRunStatus, GeoBadgeTone> = {
	PLANNED: "neutral",
	RUNNING: "info",
	VALID: "success",
	PARTIAL: "warning",
	UNAVAILABLE: "neutral",
	NEEDS_MANUAL: "warning",
	FAILED: "danger",
	RATE_LIMITED: "warning",
	TIMEOUT: "danger",
	CAPTCHA: "warning",
	NETWORK_ERROR: "danger",
};

export function GeoRunStatusBadge({ status }: { status: GeoRunStatus }) {
	return <GeoStatusBadge label={GEO_RUN_STATUS_LABELS[status]} tone={RUN_TONES[status]} />;
}

const VERIFICATION_TONES: Record<GeoVerificationStatus, GeoBadgeTone> = {
	UNVERIFIED: "warning",
	LIMITED: "warning",
	PASSED: "success",
	FAILED: "danger",
};

export function GeoVerificationBadge({ status }: { status: GeoVerificationStatus }) {
	return <GeoStatusBadge label={GEO_VERIFICATION_LABELS[status]} tone={VERIFICATION_TONES[status]} />;
}

const EVALUATION_REVIEW_TONES: Record<GeoEvaluationReviewStatus, GeoBadgeTone> = {
	AUTO_ACCEPTED: "neutral",
	PENDING_REVIEW: "warning",
	CONFIRMED: "success",
	CORRECTED: "info",
};

export function GeoEvaluationReviewBadge({ status }: { status: GeoEvaluationReviewStatus }) {
	return <GeoStatusBadge label={GEO_EVALUATION_REVIEW_LABELS[status]} tone={EVALUATION_REVIEW_TONES[status]} />;
}
