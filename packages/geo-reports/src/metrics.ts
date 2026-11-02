import {
	countsAsValidSample,
	GEO_PLATFORMS,
	GEO_SURFACE_MODES,
	type GeoCitationAttribution,
	type GeoCitationOwner,
	type GeoClaimMatchStatus,
	type GeoClaimVerdict,
	type GeoEvaluationReviewStatus,
	type GeoObservationStatus,
	type GeoPlatform,
	type GeoPriority,
	type GeoRecommendation,
	type GeoRunStatus,
	type GeoSurfaceMode,
	pickCountedSamples,
} from "@workspace/geo-domain";

/** Bump when a formula below changes: reports record which definitions produced them. */
export const GEO_METRIC_VERSION = "geo-metrics-v2";

/** A rate over fewer evaluated valid samples than this is flagged as low-sample. */
export const GEO_LOW_SAMPLE_THRESHOLD = 20;
/** The same for rates over question units (stable-mention rate). */
export const GEO_LOW_UNIT_THRESHOLD = 5;
/** Valid samples a question needs in one round before its mention can be called stable. */
export const GEO_STABLE_MIN_SAMPLES = 3;

export interface MetricEvaluation {
	evaluationId: string;
	version: number;
	evaluatorVersion: string;
	brandMentioned: boolean;
	recommendation: GeoRecommendation;
	hasOrderedList: boolean;
	brandRank: number | null;
	competitorHits: { entityId: string; name?: string; mentioned: boolean; recommendation: GeoRecommendation }[];
	citations: GeoCitationAttribution[];
	reviewStatus: GeoEvaluationReviewStatus;
}

export interface MetricClaim {
	verdict: GeoClaimVerdict;
	matchStatus: GeoClaimMatchStatus;
}

/** One stored observation with its current evaluation. */
export interface MetricSample {
	observationId: string;
	slotKey: string;
	/** The sampling round: its batch, or the week a manual import falls in. */
	roundKey: string;
	roundStartedAt: string;
	promptId: string;
	questionText: string;
	promptPriority: GeoPriority | null;
	platform: GeoPlatform;
	surfaceMode: GeoSurfaceMode;
	targetId: string;
	region: string | null;
	language: string;
	promptSetId: string | null;
	promptSetVersion: number | null;
	status: GeoObservationStatus;
	sampledAt: string;
	evaluation: MetricEvaluation | null;
	claims: MetricClaim[];
}

/** One planned sample (a run slot, or a manual import), whatever became of it. */
export interface PlannedSlot {
	slotKey: string;
	platform: GeoPlatform;
	surfaceMode: GeoSurfaceMode;
	status: GeoRunStatus | GeoObservationStatus;
	sampledAt: string;
}

export interface CompetitorRef {
	entityId: string;
	name: string;
}

export type MetricValue =
	| { status: "OK"; numerator: number; denominator: number; rate: number; lowSample: boolean }
	| { status: "NO_DATA"; numerator: 0; denominator: number; reason: string };

export function metricValue(
	numerator: number,
	denominator: number,
	options: { threshold?: number; emptyReason?: string } = {},
): MetricValue {
	if (denominator <= 0) {
		return { status: "NO_DATA", numerator: 0, denominator: 0, reason: options.emptyReason ?? "没有有效样本" };
	}
	return {
		status: "OK",
		numerator,
		denominator,
		rate: numerator / denominator,
		lowSample: denominator < (options.threshold ?? GEO_LOW_SAMPLE_THRESHOLD),
	};
}

export interface SampleBreakdown {
	planned: number;
	valid: number;
	partial: number;
	refused: number;
	rateLimited: number;
	failed: number;
	pending: number;
}

export interface ValidSampleRate {
	value: MetricValue;
	breakdown: SampleBreakdown;
}

/**
 * valid / planned, with every way a sample can miss kept apart: refused or blocked,
 * rate limited, broken, still running. None of them is ever read as "not mentioned".
 */
export function validSampleRate(slots: readonly PlannedSlot[]): ValidSampleRate {
	const bySlot = new Map<string, PlannedSlot>();
	for (const slot of slots) {
		const current = bySlot.get(slot.slotKey);
		const better =
			!current ||
			(countsAsValidSample(slot.status) !== countsAsValidSample(current.status)
				? countsAsValidSample(slot.status)
				: slot.sampledAt > current.sampledAt);
		if (better) bySlot.set(slot.slotKey, slot);
	}
	const counted = [...bySlot.values()];
	const breakdown: SampleBreakdown = {
		planned: counted.length,
		valid: 0,
		partial: 0,
		refused: 0,
		rateLimited: 0,
		failed: 0,
		pending: 0,
	};
	for (const slot of counted) {
		switch (slot.status) {
			case "VALID":
				breakdown.valid++;
				break;
			case "PARTIAL":
				breakdown.partial++;
				break;
			case "UNAVAILABLE":
			case "NEEDS_MANUAL":
			case "CAPTCHA":
				breakdown.refused++;
				break;
			case "RATE_LIMITED":
				breakdown.rateLimited++;
				break;
			case "PLANNED":
			case "RUNNING":
				breakdown.pending++;
				break;
			default:
				breakdown.failed++;
		}
	}
	return {
		value: metricValue(breakdown.valid, breakdown.planned, { emptyReason: "没有计划采样" }),
		breakdown,
	};
}

/** Re-samples collapse into their slot, then only complete, evaluated answers remain. */
export function evaluatedValidSamples(samples: readonly MetricSample[]): {
	valid: MetricSample[];
	evaluated: (MetricSample & { evaluation: MetricEvaluation })[];
} {
	const valid = pickCountedSamples(samples).filter((sample) => countsAsValidSample(sample.status));
	const evaluated = valid.filter(
		(sample): sample is MetricSample & { evaluation: MetricEvaluation } => sample.evaluation !== null,
	);
	return { valid, evaluated };
}

export interface StableMention {
	value: MetricValue;
	stableUnits: number;
	sufficientUnits: number;
	insufficientUnits: number;
}

/** Valid samples a unit needs mentioned in: two of three, or the same share of more. */
export function stableThreshold(validCount: number): number {
	return Math.ceil((validCount * 2) / 3);
}

/**
 * Units are question × round within one platform and surface mode. A unit with fewer
 * than three evaluated valid samples is "insufficient": it stays out of the rate and is
 * reported as such, never counted as unstable.
 */
export function stableMention(evaluated: readonly (MetricSample & { evaluation: MetricEvaluation })[]): StableMention {
	const units = new Map<string, { total: number; mentioned: number }>();
	for (const sample of evaluated) {
		const key = `${sample.roundKey}|${sample.promptId}|${sample.platform}|${sample.surfaceMode}`;
		const unit = units.get(key) ?? { total: 0, mentioned: 0 };
		unit.total++;
		if (sample.evaluation.brandMentioned) unit.mentioned++;
		units.set(key, unit);
	}
	let stableUnits = 0;
	let sufficientUnits = 0;
	let insufficientUnits = 0;
	for (const unit of units.values()) {
		if (unit.total < GEO_STABLE_MIN_SAMPLES) {
			insufficientUnits++;
			continue;
		}
		sufficientUnits++;
		if (unit.mentioned >= stableThreshold(unit.total)) stableUnits++;
	}
	return {
		value: metricValue(stableUnits, sufficientUnits, {
			threshold: GEO_LOW_UNIT_THRESHOLD,
			emptyReason: insufficientUnits > 0 ? "样本不足：没有问法在本轮取得三次有效采样" : "没有有效样本",
		}),
		stableUnits,
		sufficientUnits,
		insufficientUnits,
	};
}

export interface CompetitorCoverage {
	entityId: string;
	name: string;
	mentioned: MetricValue;
	recommended: MetricValue;
}

export interface CitationDomain {
	host: string;
	owner: GeoCitationOwner;
	entityId: string | null;
	count: number;
	samples: number;
}

export interface CitationDistribution {
	status: "OK" | "NOT_PROVIDED";
	totalCitations: number;
	samplesWithCitations: MetricValue;
	byOwner: Record<GeoCitationOwner, number>;
	domains: CitationDomain[];
}

export function citationDistribution(
	evaluated: readonly (MetricSample & { evaluation: MetricEvaluation })[],
): CitationDistribution {
	const byOwner: Record<GeoCitationOwner, number> = { OWN: 0, COMPETITOR: 0, THIRD_PARTY: 0 };
	const domains = new Map<string, CitationDomain>();
	let total = 0;
	let withCitations = 0;
	for (const sample of evaluated) {
		const citations = sample.evaluation.citations;
		if (citations.length > 0) withCitations++;
		const seenHosts = new Set<string>();
		for (const citation of citations) {
			total++;
			byOwner[citation.owner]++;
			const host = citation.host ?? "（无法识别的地址）";
			const entry = domains.get(host) ?? {
				host,
				owner: citation.owner,
				entityId: citation.entityId,
				count: 0,
				samples: 0,
			};
			entry.count++;
			if (!seenHosts.has(host)) {
				entry.samples++;
				seenHosts.add(host);
			}
			domains.set(host, entry);
		}
	}
	return {
		status: total === 0 ? "NOT_PROVIDED" : "OK",
		totalCitations: total,
		samplesWithCitations: metricValue(withCitations, evaluated.length),
		byOwner,
		domains: [...domains.values()].sort((a, b) => b.count - a.count || a.host.localeCompare(b.host)),
	};
}

export interface ErrorDescriptionRate {
	value: MetricValue;
	confirmedErrors: number;
	checkable: number;
	awaitingTechReview: number;
	unverified: number;
}

/**
 * Confirmed errors over checkable claims. A claim is checkable once it is settled
 * against approved knowledge (it matched, or a technical reviewer decided it); a
 * flagged mismatch waits for that review and a claim nothing approved covers stays
 * unverified. Neither counts as an error.
 */
export function errorDescriptionRate(
	evaluated: readonly (MetricSample & { evaluation: MetricEvaluation })[],
): ErrorDescriptionRate {
	let confirmedErrors = 0;
	let checkable = 0;
	let awaitingTechReview = 0;
	let unverified = 0;
	for (const claim of evaluated.flatMap((sample) => sample.claims)) {
		if (claim.verdict === "ERROR") {
			confirmedErrors++;
			checkable++;
		} else if (claim.verdict === "CORRECT") checkable++;
		else if (claim.matchStatus === "MISMATCH") awaitingTechReview++;
		else unverified++;
	}
	return {
		value: metricValue(confirmedErrors, checkable, { emptyReason: "没有可核对的事实断言" }),
		confirmedErrors,
		checkable,
		awaitingTechReview,
		unverified,
	};
}

export interface CellMetrics {
	platform: GeoPlatform;
	surfaceMode: GeoSurfaceMode;
	validSampleRate: ValidSampleRate;
	validSamples: number;
	evaluatedSamples: number;
	pendingEvaluation: number;
	mentionRate: MetricValue;
	stableMention: StableMention;
	recommendationRate: MetricValue;
	/** Recommendations the rules or a model suggested that no one has confirmed: outside the rate until reviewed. */
	recommendationsAwaitingReview: number;
	top3Rate: MetricValue;
	competitors: CompetitorCoverage[];
	citations: CitationDistribution;
	errorRate: ErrorDescriptionRate;
	observationIds: string[];
}

export function cellKey(platform: GeoPlatform, surfaceMode: GeoSurfaceMode): string {
	return `${platform}|${surfaceMode}`;
}

/** Every metric of PRD 5.2 for one platform and surface mode; callers never pass samples of two cells. */
export function computeCellMetrics(input: {
	platform: GeoPlatform;
	surfaceMode: GeoSurfaceMode;
	samples: readonly MetricSample[];
	slots: readonly PlannedSlot[];
	competitors: readonly CompetitorRef[];
}): CellMetrics {
	const { valid, evaluated } = evaluatedValidSamples(input.samples);
	const mentioned = evaluated.filter((sample) => sample.evaluation.brandMentioned).length;
	const confirmedRecommendations = evaluated.filter(
		(sample) =>
			sample.evaluation.recommendation === "RECOMMENDED" && sample.evaluation.reviewStatus !== "PENDING_REVIEW",
	).length;
	const awaiting = evaluated.filter(
		(sample) =>
			sample.evaluation.recommendation === "RECOMMENDED" && sample.evaluation.reviewStatus === "PENDING_REVIEW",
	).length;
	const ordered = evaluated.filter((sample) => sample.evaluation.hasOrderedList);
	const top3 = ordered.filter(
		(sample) => sample.evaluation.brandRank !== null && sample.evaluation.brandRank <= 3,
	).length;

	const competitors = input.competitors.map((competitor) => {
		// An evaluation holds one entry per competitor its dictionary version had, mentioned or
		// not, so a missing entry means the answer was never checked for this one: not a "no".
		const assessed = evaluated.flatMap((sample) => {
			const hit = sample.evaluation.competitorHits.find((entry) => entry.entityId === competitor.entityId);
			return hit ? [hit] : [];
		});
		const emptyReason = "该竞品加入词典前的样本未按其评估，暂无可比样本";
		return {
			entityId: competitor.entityId,
			name: competitor.name,
			mentioned: metricValue(assessed.filter((hit) => hit.mentioned).length, assessed.length, { emptyReason }),
			recommended: metricValue(assessed.filter((hit) => hit.recommendation === "RECOMMENDED").length, assessed.length, {
				emptyReason,
			}),
		};
	});

	return {
		platform: input.platform,
		surfaceMode: input.surfaceMode,
		validSampleRate: validSampleRate(input.slots),
		validSamples: valid.length,
		evaluatedSamples: evaluated.length,
		pendingEvaluation: valid.length - evaluated.length,
		mentionRate: metricValue(mentioned, evaluated.length),
		stableMention: stableMention(evaluated),
		recommendationRate: metricValue(confirmedRecommendations, evaluated.length),
		recommendationsAwaitingReview: awaiting,
		top3Rate: metricValue(top3, ordered.length, { emptyReason: "没有可判定排序的回答" }),
		competitors,
		citations: citationDistribution(evaluated),
		errorRate: errorDescriptionRate(evaluated),
		observationIds: evaluated.map((sample) => sample.observationId),
	};
}

export function compareCells(a: { platform: GeoPlatform; surfaceMode: GeoSurfaceMode }, b: typeof a): number {
	return (
		GEO_PLATFORMS.indexOf(a.platform) - GEO_PLATFORMS.indexOf(b.platform) ||
		GEO_SURFACE_MODES.indexOf(a.surfaceMode) - GEO_SURFACE_MODES.indexOf(b.surfaceMode)
	);
}

export function groupByCell<T extends { platform: GeoPlatform; surfaceMode: GeoSurfaceMode }>(
	rows: readonly T[],
): Map<string, T[]> {
	const groups = new Map<string, T[]>();
	for (const row of rows) {
		const key = cellKey(row.platform, row.surfaceMode);
		const group = groups.get(key) ?? [];
		group.push(row);
		groups.set(key, group);
	}
	return groups;
}

export type SummaryRate = { status: "OK"; rate: number; lowSample: boolean } | { status: "NO_DATA"; reason: string };

export interface EqualWeightSummary {
	value: SummaryRate;
	cellsIncluded: number;
	cellsWithoutData: number;
	weighting: "EQUAL";
	note: string;
}

/**
 * The plain mean of each cell's own rate, labelled as an equal-weight internal summary.
 * It has no numerator or denominator of its own, since summed counts would not give
 * this rate. Cells without data are left out, not averaged in as 0.
 */
export function equalWeightSummary(
	cells: readonly CellMetrics[],
	pick: (cell: CellMetrics) => MetricValue,
	note: string,
): EqualWeightSummary {
	const rates = cells.map(pick).flatMap((value) => (value.status === "OK" ? [value] : []));
	const summary = {
		cellsIncluded: rates.length,
		cellsWithoutData: cells.length - rates.length,
		weighting: "EQUAL" as const,
		note,
	};
	if (rates.length === 0) return { ...summary, value: { status: "NO_DATA", reason: "没有有效样本" } };
	return {
		...summary,
		value: {
			status: "OK",
			rate: rates.reduce((sum, value) => sum + value.rate, 0) / rates.length,
			lowSample: rates.some((value) => value.lowSample),
		},
	};
}

export function formatSummaryRate(value: SummaryRate): string {
	return value.status === "OK" ? `${(value.rate * 100).toFixed(1)}%` : "数据不足";
}

export function formatMetric(value: MetricValue, options: { notProvided?: boolean } = {}): string {
	if (options.notProvided) return "不提供";
	if (value.status === "NO_DATA") return "数据不足";
	return `${(value.rate * 100).toFixed(1)}%`;
}
