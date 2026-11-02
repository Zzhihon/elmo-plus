import { evaluatedValidSamples, type MetricSample, type MetricValue, metricValue } from "./metrics";

/** The conditions PRD 5.3 fixes for a comparison. Any change between two rounds is a break in the line. */
export interface ComparisonConditions {
	promptSet: string;
	targets: string;
	regionLanguage: string;
	evaluatorVersions: string;
}

export const CONDITION_LABELS: Record<keyof ComparisonConditions, string> = {
	promptSet: "问法集版本",
	targets: "采样目标",
	regionLanguage: "地区/语言",
	evaluatorVersions: "评估规则版本",
};

export interface TrendPoint {
	roundKey: string;
	startedAt: string;
	validSamples: number;
	mentionRate: MetricValue;
	recommendationRate: MetricValue;
	conditions: ComparisonConditions;
	/** Conditions that differ from the previous point; non-empty means the two must not be read as a trend. */
	breakpoint: (keyof ComparisonConditions)[];
}

function joinSorted(values: Iterable<string>): string {
	return [...new Set(values)].sort().join(",");
}

export function conditionsOf(samples: readonly MetricSample[]): ComparisonConditions {
	return {
		promptSet: joinSorted(samples.map((sample) => `${sample.promptSetId ?? "-"}@${sample.promptSetVersion ?? "-"}`)),
		targets: joinSorted(samples.map((sample) => sample.targetId)),
		regionLanguage: joinSorted(samples.map((sample) => `${sample.region ?? "-"}/${sample.language}`)),
		evaluatorVersions: joinSorted(
			samples.flatMap((sample) => (sample.evaluation ? [sample.evaluation.evaluatorVersion] : [])),
		),
	};
}

export function changedConditions(
	previous: ComparisonConditions,
	next: ComparisonConditions,
): (keyof ComparisonConditions)[] {
	return (Object.keys(CONDITION_LABELS) as (keyof ComparisonConditions)[]).filter((key) => previous[key] !== next[key]);
}

/** One point per sampling round, oldest first, each marked where its conditions changed. */
export function buildTrend(samples: readonly MetricSample[]): TrendPoint[] {
	const rounds = new Map<string, MetricSample[]>();
	for (const sample of samples) {
		const group = rounds.get(sample.roundKey) ?? [];
		group.push(sample);
		rounds.set(sample.roundKey, group);
	}
	const points = [...rounds.entries()].map(([roundKey, group]) => {
		const { valid, evaluated } = evaluatedValidSamples(group);
		const mentioned = evaluated.filter((sample) => sample.evaluation.brandMentioned).length;
		const recommended = evaluated.filter(
			(sample) =>
				sample.evaluation.recommendation === "RECOMMENDED" && sample.evaluation.reviewStatus !== "PENDING_REVIEW",
		).length;
		return {
			roundKey,
			startedAt: group.reduce(
				(min, sample) => (sample.roundStartedAt < min ? sample.roundStartedAt : min),
				group[0]?.roundStartedAt ?? "",
			),
			validSamples: valid.length,
			mentionRate: metricValue(mentioned, evaluated.length),
			recommendationRate: metricValue(recommended, evaluated.length),
			conditions: conditionsOf(group),
			breakpoint: [] as (keyof ComparisonConditions)[],
		};
	});
	points.sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.roundKey.localeCompare(b.roundKey));
	for (let index = 1; index < points.length; index++) {
		const previous = points[index - 1];
		const point = points[index];
		if (previous && point) point.breakpoint = changedConditions(previous.conditions, point.conditions);
	}
	return points;
}

export type TrendKind =
	| "SUSTAINED_IMPROVEMENT"
	| "SUSTAINED_DECLINE"
	| "OBSERVED_CHANGE"
	| "NO_CHANGE"
	| "INSUFFICIENT";

export interface TrendReading {
	kind: TrendKind;
	/** Change between the last two comparable rounds, in percentage points. */
	deltaPoints: number | null;
	label: string;
}

/**
 * Only rounds after the last break are compared. "Sustained" needs the last two changes
 * in the same direction across rounds that all have enough samples; anything less is
 * an observed change, however large.
 */
export function classifyTrend(points: readonly TrendPoint[], pick: (point: TrendPoint) => MetricValue): TrendReading {
	let from = 0;
	points.forEach((point, index) => {
		if (point.breakpoint.length > 0) from = index;
	});
	const comparable = points.slice(from).filter((point) => pick(point).status === "OK");
	if (comparable.length < 2) return { kind: "INSUFFICIENT", deltaPoints: null, label: "可比轮次不足，无法判断变化" };
	const rates = comparable.map((point) => {
		const value = pick(point);
		return value.status === "OK" ? value.rate : 0;
	});
	const last = rates.at(-1) ?? 0;
	const previous = rates.at(-2) ?? 0;
	const deltaPoints = Math.round((last - previous) * 1000) / 10;
	if (deltaPoints === 0) return { kind: "NO_CHANGE", deltaPoints, label: "与上一轮持平" };

	const tail = comparable.slice(-3);
	const tailRates = rates.slice(-3);
	const enoughSamples = tail.every((point) => {
		const value = pick(point);
		return value.status === "OK" && !value.lowSample;
	});
	if (tail.length === 3 && enoughSamples) {
		const [a = 0, b = 0, c = 0] = tailRates;
		if (a < b && b < c) return { kind: "SUSTAINED_IMPROVEMENT", deltaPoints, label: "持续改善（连续两轮上升）" };
		if (a > b && b > c) return { kind: "SUSTAINED_DECLINE", deltaPoints, label: "持续下降（连续两轮下降）" };
	}
	const sign = deltaPoints > 0 ? "+" : "";
	return { kind: "OBSERVED_CHANGE", deltaPoints, label: `观察到的变化（${sign}${deltaPoints} 个百分点）` };
}
