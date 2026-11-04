import { GEO_PLATFORMS, type GeoEvidenceSpan, type GeoPlatform, type GeoSurfaceMode } from "@workspace/geo-domain";
import {
	type CompetitorRef,
	chinaDate,
	evaluatedValidSamples,
	type MetricEvaluation,
	type MetricSample,
	type MetricValue,
	metricValue,
} from "@workspace/geo-reports";

type EvaluatedSample = MetricSample & { evaluation: MetricEvaluation };

/** The most realistic way an answer was captured comes first: what a buyer would actually see. */
export const HEADLINE_MODE_PREFERENCE: readonly GeoSurfaceMode[] = [
	"LIVE_SURFACE",
	"BROWSER_AGENT",
	"MANUAL_EVIDENCE",
	"MODEL_API",
];

export const CUSTOMER_MODE_LABELS: Record<GeoSurfaceMode, string> = {
	LIVE_SURFACE: "真实产品端",
	BROWSER_AGENT: "浏览器模拟用户",
	MANUAL_EVIDENCE: "人工记录",
	MODEL_API: "模型接口",
};

/**
 * One cell per platform: the most realistic capture mode that has any evaluated answer.
 * A platform's headline never pools two modes.
 */
export function pickHeadlineCells<
	T extends { platform: GeoPlatform; surfaceMode: GeoSurfaceMode; evaluatedSamples: number },
>(cells: readonly T[]): T[] {
	return GEO_PLATFORMS.flatMap((platform) => {
		for (const mode of HEADLINE_MODE_PREFERENCE) {
			const cell = cells.find(
				(candidate) =>
					candidate.platform === platform && candidate.surfaceMode === mode && candidate.evaluatedSamples > 0,
			);
			if (cell) return [cell];
		}
		return [];
	});
}

/** Change in percentage points, only when both periods have a rate to compare. */
export function rateChange(current: MetricValue, previous: MetricValue | undefined): number | null {
	if (current.status !== "OK" || !previous || previous.status !== "OK") return null;
	return Math.round((current.rate - previous.rate) * 1000) / 10;
}

/**
 * Where we stand among the brands an answer names, counted by first appearance: 1 when
 * we are named before any competitor. Null when the answer never names us.
 */
export function ownBrandPosition(
	spans: readonly Pick<GeoEvidenceSpan, "kind" | "start" | "entityId" | "text">[],
): number | null {
	const firstSeen = new Map<string, number>();
	for (const span of spans) {
		let key: string;
		if (span.kind === "BRAND") key = "own";
		else if (span.kind === "COMPETITOR") key = `competitor:${span.entityId ?? span.text.trim().toLowerCase()}`;
		else continue;
		const seen = firstSeen.get(key);
		if (seen === undefined || span.start < seen) firstSeen.set(key, span.start);
	}
	const own = firstSeen.get("own");
	if (own === undefined) return null;
	let before = 0;
	for (const [key, start] of firstSeen) if (key !== "own" && start < own) before++;
	return before + 1;
}

export interface AveragePosition {
	average: number | null;
	answers: number;
}

export function averagePosition(positions: readonly (number | null)[]): AveragePosition {
	const known = positions.filter((position): position is number => position !== null);
	if (known.length === 0) return { average: null, answers: 0 };
	return {
		average: Math.round((known.reduce((sum, position) => sum + position, 0) / known.length) * 10) / 10,
		answers: known.length,
	};
}

export interface VoiceShare {
	entityId: string | null;
	name: string;
	isOwn: boolean;
	mentions: number;
	share: number | null;
}

/**
 * Of all the times the tracked brands were named, how many were us and how many each
 * competitor: one count per answer that names the brand.
 */
export function shareOfVoice(
	evaluated: readonly EvaluatedSample[],
	competitors: readonly CompetitorRef[],
	ownName: string,
): VoiceShare[] {
	const own = evaluated.filter((sample) => sample.evaluation.brandMentioned).length;
	const counts = competitors.map((competitor) => ({
		competitor,
		mentions: evaluated.filter((sample) =>
			sample.evaluation.competitorHits.some((hit) => hit.entityId === competitor.entityId && hit.mentioned),
		).length,
	}));
	const total = own + counts.reduce((sum, entry) => sum + entry.mentions, 0);
	const share = (mentions: number) => (total > 0 ? mentions / total : null);
	return [
		{ entityId: null, name: ownName, isOwn: true, mentions: own, share: share(own) },
		...counts.map(({ competitor, mentions }) => ({
			entityId: competitor.entityId,
			name: competitor.name,
			isOwn: false,
			mentions,
			share: share(mentions),
		})),
	].sort((a, b) => b.mentions - a.mentions || Number(b.isOwn) - Number(a.isOwn));
}

export interface OwnCitation {
	/** False when the platform gave no sources at all in these answers, so "0" would mislead. */
	provided: boolean;
	value: MetricValue;
}

export function ownSiteCitation(evaluated: readonly EvaluatedSample[]): OwnCitation {
	const provided = evaluated.some((sample) => sample.evaluation.citations.length > 0);
	const citing = evaluated.filter((sample) => sample.evaluation.citations.some((citation) => citation.owner === "OWN"));
	return { provided, value: metricValue(citing.length, evaluated.length) };
}

/** Monday of the China-time week an instant falls in. */
export function chinaWeekStart(instant: string): string {
	const day = chinaDate(new Date(instant));
	const date = new Date(`${day}T00:00:00Z`);
	const weekday = (date.getUTCDay() + 6) % 7;
	return new Date(date.getTime() - weekday * 86_400_000).toISOString().slice(0, 10);
}

export interface WeekPoint {
	week: string;
	mentionRate: MetricValue;
}

/** One point per week that has any sample; failed answers stay out of the rate. */
export function weeklyMentionRate(samples: readonly MetricSample[]): WeekPoint[] {
	const weeks = new Map<string, MetricSample[]>();
	for (const sample of samples) {
		const week = chinaWeekStart(sample.sampledAt);
		const group = weeks.get(week) ?? [];
		group.push(sample);
		weeks.set(week, group);
	}
	return [...weeks.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([week, group]) => {
			const { evaluated } = evaluatedValidSamples(group);
			return {
				week,
				mentionRate: metricValue(
					evaluated.filter((sample) => sample.evaluation.brandMentioned).length,
					evaluated.length,
				),
			};
		});
}

export interface RoleRef {
	key: string;
	title: string;
}

export const NO_ROLE: RoleRef = { key: "none", title: "未指定角色" };

/** Mention rate of each buyer role's questions, from one cell's evaluated answers. */
export function mentionRateByRole(
	evaluated: readonly EvaluatedSample[],
	roleOf: (promptId: string) => RoleRef | null,
): Map<string, MetricValue> {
	const groups = new Map<string, { total: number; mentioned: number }>();
	for (const sample of evaluated) {
		const key = (roleOf(sample.promptId) ?? NO_ROLE).key;
		const group = groups.get(key) ?? { total: 0, mentioned: 0 };
		group.total++;
		if (sample.evaluation.brandMentioned) group.mentioned++;
		groups.set(key, group);
	}
	return new Map([...groups].map(([key, group]) => [key, metricValue(group.mentioned, group.total)]));
}

export interface SnippetPart {
	start: number;
	text: string;
	mark: "own" | "competitor" | null;
}

export interface AnswerSnippet {
	parts: SnippetPart[];
	cutBefore: boolean;
	cutAfter: boolean;
}

const SNIPPET_LEAD = 40;

/**
 * A window of the answer around the first brand it names, split so our brand and the
 * competitors can be highlighted. Overlapping spans keep the first one.
 */
/** Answers arrive as markdown; a snippet is shown as plain text, so its markup would only be noise. */
function plainText(markdown: string): string {
	return markdown
		.replace(/^\s{0,3}(#{1,6}|[-*+]|>|\d+\.)\s+/gm, "")
		.replace(/(\*\*|__|`|~~)/g, "")
		.replace(/^\s*\|?(\s*:?-{3,}:?\s*\|)+\s*$/gm, "")
		.replace(/\s*\|\s*/g, " ");
}

export function answerSnippet(
	text: string,
	spans: readonly Pick<GeoEvidenceSpan, "kind" | "start" | "end">[],
	maxLength = 240,
): AnswerSnippet {
	const marks = spans
		.filter((span) => (span.kind === "BRAND" || span.kind === "COMPETITOR") && span.end > span.start)
		.map(
			(span) =>
				({
					start: span.start,
					end: Math.min(span.end, text.length),
					mark: span.kind === "BRAND" ? "own" : "competitor",
				}) as const,
		)
		.filter((span) => span.start < text.length)
		.sort((a, b) => a.start - b.start || b.end - a.end);
	const from = Math.max(0, (marks[0]?.start ?? 0) - SNIPPET_LEAD);
	const to = Math.min(text.length, from + maxLength);
	const parts: SnippetPart[] = [];
	let cursor = from;
	for (const span of marks) {
		if (span.start < cursor || span.start >= to) continue;
		if (span.start > cursor) parts.push({ start: cursor, text: text.slice(cursor, span.start), mark: null });
		const end = Math.min(span.end, to);
		parts.push({ start: span.start, text: text.slice(span.start, end), mark: span.mark });
		cursor = end;
	}
	if (cursor < to) parts.push({ start: cursor, text: text.slice(cursor, to), mark: null });
	return {
		parts: parts.map((part) => ({ ...part, text: plainText(part.text) })).filter((part) => part.text.length > 0),
		cutBefore: from > 0,
		cutAfter: to < text.length,
	};
}
