import type { GeoPlatform, GeoSurfaceMode } from "@workspace/geo-domain";
import {
	cellKey,
	compareCells,
	evaluatedValidSamples,
	groupByCell,
	type MetricSample,
	type MetricValue,
	metricValue,
} from "./metrics";
import { CONDITION_LABELS, type ComparisonConditions, changedConditions, conditionsOf } from "./trends";

export interface BatchSide {
	batchId: string;
	samples: readonly MetricSample[];
}

export interface RoundFigures {
	validSamples: number;
	evaluatedSamples: number;
	mentionRate: MetricValue;
	recommendationRate: MetricValue;
	top3Rate: MetricValue;
}

export interface BatchComparisonRow {
	platform: GeoPlatform;
	surfaceMode: GeoSurfaceMode;
	before: RoundFigures;
	after: RoundFigures;
	/** Percentage points, null when either side has no data. */
	mentionDelta: number | null;
	recommendationDelta: number | null;
	/** Conditions that differ between the two rounds; any entry makes the comparison unsound. */
	conditionChanges: string[];
}

export interface BatchComparison {
	sameConditions: boolean;
	/** Questions sampled in both rounds: the only ones compared. */
	comparedPromptIds: string[];
	excludedPromptIds: string[];
	rows: BatchComparisonRow[];
	/** One pair of rounds can only ever show an observed change: sustained improvement needs two in a row. */
	reading: string;
}

function figures(samples: readonly MetricSample[]): RoundFigures {
	const { valid, evaluated } = evaluatedValidSamples(samples);
	const ordered = evaluated.filter((sample) => sample.evaluation.hasOrderedList);
	return {
		validSamples: valid.length,
		evaluatedSamples: evaluated.length,
		mentionRate: metricValue(evaluated.filter((sample) => sample.evaluation.brandMentioned).length, evaluated.length),
		recommendationRate: metricValue(
			evaluated.filter(
				(sample) =>
					sample.evaluation.recommendation === "RECOMMENDED" && sample.evaluation.reviewStatus !== "PENDING_REVIEW",
			).length,
			evaluated.length,
		),
		top3Rate: metricValue(
			ordered.filter((sample) => sample.evaluation.brandRank !== null && sample.evaluation.brandRank <= 3).length,
			ordered.length,
			{ emptyReason: "没有可判定排序的回答" },
		),
	};
}

function delta(before: MetricValue, after: MetricValue): number | null {
	if (before.status !== "OK" || after.status !== "OK") return null;
	return Math.round((after.rate - before.rate) * 1000) / 10;
}

function describeChanges(before: readonly MetricSample[], after: readonly MetricSample[]): string[] {
	if (before.length === 0 || after.length === 0) return [];
	const keys = changedConditions(conditionsOf(before), conditionsOf(after));
	return keys.map((key: keyof ComparisonConditions) => CONDITION_LABELS[key]);
}

/**
 * Two rounds under the same conditions (PRD 5.3, UAT-14): per platform and surface mode,
 * restricted to the questions both rounds sampled, with any condition that still differs
 * spelled out. Every figure traces back to the observations passed in.
 */
export function compareBatches(before: BatchSide, after: BatchSide): BatchComparison {
	const beforePrompts = new Set(before.samples.map((sample) => sample.promptId));
	const afterPrompts = new Set(after.samples.map((sample) => sample.promptId));
	const compared = [...beforePrompts].filter((promptId) => afterPrompts.has(promptId)).sort();
	const comparedSet = new Set(compared);
	const excluded = [...new Set([...beforePrompts, ...afterPrompts])].filter((id) => !comparedSet.has(id)).sort();
	const beforeCells = groupByCell(before.samples.filter((sample) => comparedSet.has(sample.promptId)));
	const afterCells = groupByCell(after.samples.filter((sample) => comparedSet.has(sample.promptId)));

	const rows: BatchComparisonRow[] = [];
	for (const key of new Set([...beforeCells.keys(), ...afterCells.keys()])) {
		const [platform, surfaceMode] = key.split("|") as [GeoPlatform, GeoSurfaceMode];
		const beforeSamples = beforeCells.get(cellKey(platform, surfaceMode)) ?? [];
		const afterSamples = afterCells.get(cellKey(platform, surfaceMode)) ?? [];
		const beforeFigures = figures(beforeSamples);
		const afterFigures = figures(afterSamples);
		const conditionChanges = describeChanges(beforeSamples, afterSamples);
		if (beforeSamples.length === 0 || afterSamples.length === 0) conditionChanges.push("该平台只在一轮中采样");
		rows.push({
			platform,
			surfaceMode,
			before: beforeFigures,
			after: afterFigures,
			mentionDelta: delta(beforeFigures.mentionRate, afterFigures.mentionRate),
			recommendationDelta: delta(beforeFigures.recommendationRate, afterFigures.recommendationRate),
			conditionChanges,
		});
	}
	rows.sort(compareCells);
	const sameConditions = rows.every((row) => row.conditionChanges.length === 0) && excluded.length === 0;
	return {
		sameConditions,
		comparedPromptIds: compared,
		excludedPromptIds: excluded,
		rows,
		reading: sameConditions
			? "两轮条件一致。单次前后对比只能视为观察到的变化，至少连续两轮同向变化才可判断为持续改善。"
			: "两轮条件不完全一致（见各行说明），差异不能直接归因于优化动作。",
	};
}
