import type { GeoPlatform, GeoPriority, GeoSurfaceMode } from "@workspace/geo-domain";
import {
	type CellMetrics,
	type CompetitorRef,
	cellKey,
	compareCells,
	computeCellMetrics,
	type EqualWeightSummary,
	equalWeightSummary,
	evaluatedValidSamples,
	GEO_STABLE_MIN_SAMPLES,
	groupByCell,
	type MetricSample,
	type PlannedSlot,
	stableThreshold,
} from "./metrics";
import { buildTrend, classifyTrend, type TrendPoint, type TrendReading } from "./trends";

export interface CellTrend {
	platform: GeoPlatform;
	surfaceMode: GeoSurfaceMode;
	points: TrendPoint[];
	mention: TrendReading;
	recommendation: TrendReading;
}

export type PromptCellState = "STABLE" | "GAP" | "INSUFFICIENT" | "NO_DATA";

export interface PromptCell {
	platform: GeoPlatform;
	surfaceMode: GeoSurfaceMode;
	evaluated: number;
	mentioned: number;
	recommended: number;
	/** How the question stands in this cell's latest round. */
	latestRound: { roundKey: string; evaluated: number; mentioned: number; state: PromptCellState } | null;
	/** Competitors named in the latest round's samples, by entity id. */
	competitorsInLatestRound: string[];
	latestObservationIds: string[];
}

export interface PromptRow {
	promptId: string;
	questionText: string;
	priority: GeoPriority | null;
	cells: PromptCell[];
}

export interface Gap {
	promptId: string;
	questionText: string;
	priority: GeoPriority | null;
	platform: GeoPlatform;
	surfaceMode: GeoSurfaceMode;
	roundKey: string;
	evaluated: number;
	mentioned: number;
	competitorIds: string[];
	observationIds: string[];
}

/** One surface mode's headline figures: an equal-weight mean over that mode's platforms only. */
export interface SurfaceModeOverview {
	surfaceMode: GeoSurfaceMode;
	mention: EqualWeightSummary;
	recommendation: EqualWeightSummary;
	planned: number;
	valid: number;
	pendingEvaluation: number;
}

export interface InsightsOverview {
	bySurfaceMode: SurfaceModeOverview[];
	/** Mixes answers captured in different ways, so it exists only when someone explicitly asks for it. */
	crossMode: { mention: EqualWeightSummary; recommendation: EqualWeightSummary } | null;
}

export const GEO_CROSS_MODE_NOTE =
	"跨采样方式等权平均：混合了用户界面实测、模型 API 代理评测与人工证据，不代表其中任何一种口径，仅供内部参考。";

export interface Insights {
	cells: CellMetrics[];
	trends: CellTrend[];
	prompts: PromptRow[];
	gaps: Gap[];
	overview: InsightsOverview;
	totals: { planned: number; valid: number; evaluated: number; pendingEvaluation: number };
	/** True when no cell has a single valid sample: every rate must read "数据不足", never 0%. */
	noData: boolean;
	evaluatorVersions: string[];
}

function latestRoundOf(samples: readonly MetricSample[]): string | null {
	let latest: MetricSample | null = null;
	for (const sample of samples) {
		if (!latest || sample.roundStartedAt > latest.roundStartedAt) latest = sample;
	}
	return latest?.roundKey ?? null;
}

function cellState(latestCount: number, latestMentioned: number): PromptCellState {
	if (latestCount === 0) return "NO_DATA";
	if (latestCount < GEO_STABLE_MIN_SAMPLES) return "INSUFFICIENT";
	return latestMentioned >= stableThreshold(latestCount) ? "STABLE" : "GAP";
}

function promptCell(cell: CellMetrics, samples: readonly MetricSample[], latestKey: string | null): PromptCell {
	const { evaluated } = evaluatedValidSamples(samples);
	const latest = latestKey ? evaluated.filter((sample) => sample.roundKey === latestKey) : [];
	const latestMentioned = latest.filter((sample) => sample.evaluation.brandMentioned).length;
	const competitors = latest.flatMap((sample) =>
		sample.evaluation.competitorHits.filter((hit) => hit.mentioned).map((hit) => hit.entityId),
	);
	return {
		platform: cell.platform,
		surfaceMode: cell.surfaceMode,
		evaluated: evaluated.length,
		mentioned: evaluated.filter((sample) => sample.evaluation.brandMentioned).length,
		recommended: evaluated.filter(
			(sample) =>
				sample.evaluation.recommendation === "RECOMMENDED" && sample.evaluation.reviewStatus !== "PENDING_REVIEW",
		).length,
		latestRound: latestKey
			? {
					roundKey: latestKey,
					evaluated: latest.length,
					mentioned: latestMentioned,
					state: cellState(latest.length, latestMentioned),
				}
			: null,
		competitorsInLatestRound: [...new Set(competitors)],
		latestObservationIds: latest.map((sample) => sample.observationId),
	};
}

function groupByPrompt(samples: readonly MetricSample[]): Map<string, MetricSample[]> {
	const byPrompt = new Map<string, MetricSample[]>();
	for (const sample of samples) {
		const group = byPrompt.get(sample.promptId) ?? [];
		group.push(sample);
		byPrompt.set(sample.promptId, group);
	}
	return byPrompt;
}

const priorityRank = (priority: GeoPriority | null) => (priority ? Number(priority.slice(1)) : 9);

function promptRows(
	samples: readonly MetricSample[],
	cells: readonly CellMetrics[],
): { rows: PromptRow[]; gaps: Gap[] } {
	const latestByCell = new Map<string, string | null>();
	for (const [key, group] of groupByCell(samples)) latestByCell.set(key, latestRoundOf(group));

	const rows: PromptRow[] = [];
	for (const [promptId, group] of groupByPrompt(samples)) {
		const first = group[0];
		if (!first) continue;
		const byCell = groupByCell(group);
		rows.push({
			promptId,
			questionText: first.questionText,
			priority: first.promptPriority,
			cells: cells.map((cell) => {
				const key = cellKey(cell.platform, cell.surfaceMode);
				return promptCell(cell, byCell.get(key) ?? [], latestByCell.get(key) ?? null);
			}),
		});
	}
	const gaps: Gap[] = rows.flatMap((row) =>
		row.cells.flatMap((cell) =>
			cell.latestRound?.state === "GAP"
				? [
						{
							promptId: row.promptId,
							questionText: row.questionText,
							priority: row.priority,
							platform: cell.platform,
							surfaceMode: cell.surfaceMode,
							roundKey: cell.latestRound.roundKey,
							evaluated: cell.latestRound.evaluated,
							mentioned: cell.latestRound.mentioned,
							competitorIds: cell.competitorsInLatestRound,
							observationIds: cell.latestObservationIds,
						},
					]
				: [],
		),
	);
	rows.sort(
		(a, b) => priorityRank(a.priority) - priorityRank(b.priority) || a.questionText.localeCompare(b.questionText),
	);
	gaps.sort(
		(a, b) =>
			priorityRank(a.priority) - priorityRank(b.priority) ||
			b.competitorIds.length - a.competitorIds.length ||
			a.mentioned - b.mentioned,
	);
	return { rows, gaps };
}

function surfaceModeOverview(cells: readonly CellMetrics[]): SurfaceModeOverview[] {
	const modes = [...new Set(cells.map((cell) => cell.surfaceMode))];
	return modes.map((surfaceMode) => {
		const own = cells.filter((cell) => cell.surfaceMode === surfaceMode);
		const note = "同一采样方式内跨平台等权平均，仅用于内部概览；各平台的口径与样本量见分平台数据。";
		return {
			surfaceMode,
			mention: equalWeightSummary(own, (cell) => cell.mentionRate, note),
			recommendation: equalWeightSummary(own, (cell) => cell.recommendationRate, note),
			planned: own.reduce((sum, cell) => sum + cell.validSampleRate.breakdown.planned, 0),
			valid: own.reduce((sum, cell) => sum + cell.validSamples, 0),
			pendingEvaluation: own.reduce((sum, cell) => sum + cell.pendingEvaluation, 0),
		};
	});
}

/**
 * Everything the insight pages and reports show, per platform and surface mode. Samples
 * of different cells are never pooled; headline figures stay within one surface mode
 * unless `crossMode` explicitly asks for the labelled mixed summary.
 */
export function computeInsights(input: {
	samples: readonly MetricSample[];
	slots: readonly PlannedSlot[];
	competitors: readonly CompetitorRef[];
	crossMode?: boolean;
}): Insights {
	const sampleGroups = groupByCell(input.samples);
	const slotGroups = groupByCell(input.slots);
	const keys = new Set([...sampleGroups.keys(), ...slotGroups.keys()]);
	const cells: CellMetrics[] = [];
	const trends: CellTrend[] = [];
	for (const key of keys) {
		const [platform, surfaceMode] = key.split("|") as [GeoPlatform, GeoSurfaceMode];
		const samples = sampleGroups.get(key) ?? [];
		cells.push(
			computeCellMetrics({
				platform,
				surfaceMode,
				samples,
				slots: slotGroups.get(key) ?? [],
				competitors: input.competitors,
			}),
		);
		const points = buildTrend(samples);
		trends.push({
			platform,
			surfaceMode,
			points,
			mention: classifyTrend(points, (point) => point.mentionRate),
			recommendation: classifyTrend(points, (point) => point.recommendationRate),
		});
	}
	cells.sort(compareCells);
	trends.sort(compareCells);
	const { rows, gaps } = promptRows(input.samples, cells);
	const totals = cells.reduce(
		(sum, cell) => ({
			planned: sum.planned + cell.validSampleRate.breakdown.planned,
			valid: sum.valid + cell.validSamples,
			evaluated: sum.evaluated + cell.evaluatedSamples,
			pendingEvaluation: sum.pendingEvaluation + cell.pendingEvaluation,
		}),
		{ planned: 0, valid: 0, evaluated: 0, pendingEvaluation: 0 },
	);
	return {
		cells,
		trends,
		prompts: rows,
		gaps,
		overview: {
			bySurfaceMode: surfaceModeOverview(cells),
			crossMode: input.crossMode
				? {
						mention: equalWeightSummary(cells, (cell) => cell.mentionRate, GEO_CROSS_MODE_NOTE),
						recommendation: equalWeightSummary(cells, (cell) => cell.recommendationRate, GEO_CROSS_MODE_NOTE),
					}
				: null,
		},
		totals,
		noData: totals.valid === 0,
		evaluatorVersions: [
			...new Set(input.samples.flatMap((sample) => (sample.evaluation ? [sample.evaluation.evaluatorVersion] : []))),
		].sort(),
	};
}
