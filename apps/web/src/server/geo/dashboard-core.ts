import {
	assertGeoPermission,
	GEO_FINDING_SEVERITIES,
	type GeoEvidenceSpan,
	type GeoFindingSeverity,
	type GeoPlatform,
	type GeoPrincipal,
	type GeoPriority,
	type GeoRecommendationKind,
	type GeoSurfaceMode,
} from "@workspace/geo-domain";
import {
	type CellMetrics,
	chinaDate,
	chinaDayRange,
	computeInsights,
	evaluatedValidSamples,
	type MetricEvaluation,
	type MetricSample,
	type MetricValue,
} from "@workspace/geo-reports";
import { loadMetricData, type PromptSetRef } from "@workspace/geo-reports/queries";
import { db } from "@workspace/lib/db/db";
import {
	geoBrandEntities,
	geoBuyerRoles,
	geoDashboardLayouts,
	geoEvaluations,
	geoObservations,
	geoPromptSetItems,
	geoPromptSets,
	geoRecommendations,
	geoSiteAuditFindings,
} from "@workspace/lib/db/schema";
import { and, asc, count, desc, eq, inArray, max, sql } from "drizzle-orm";
import { z } from "zod";
import { DASHBOARD_CARD_TYPES, type DashboardCard, normalizeDashboardLayout } from "./dashboard-layout";
import {
	type AnswerSnippet,
	type AveragePosition,
	answerSnippet,
	averagePosition,
	mentionRateByRole,
	NO_ROLE,
	type OwnCitation,
	ownBrandPosition,
	ownSiteCitation,
	pickHeadlineCells,
	type RoleRef,
	rateChange,
	shareOfVoice,
	type VoiceShare,
	type WeekPoint,
	weeklyMentionRate,
} from "./dashboard-metrics";

const PERIOD_DAYS = 28;
const TREND_WEEKS = 12;
const DAY_MS = 86_400_000;

type EvaluatedSample = MetricSample & { evaluation: MetricEvaluation };

export interface DashboardCompetitorRow {
	entityId: string | null;
	name: string;
	isOwn: boolean;
	mentionRate: MetricValue;
	recommendationRate: MetricValue;
	share: number | null;
}

export interface DashboardPlatform {
	platform: GeoPlatform;
	surfaceMode: GeoSurfaceMode;
	evaluated: number;
	notCounted: number;
	mentionRate: MetricValue;
	mentionChange: number | null;
	recommendationRate: MetricValue;
	position: AveragePosition;
	ownCitation: OwnCitation;
	competitors: DashboardCompetitorRow[];
	trend: WeekPoint[];
}

export interface DashboardConversation {
	observationId: string;
	platform: GeoPlatform;
	surfaceMode: GeoSurfaceMode;
	question: string;
	sampledAt: string;
	brandMentioned: boolean;
	competitorNames: string[];
	snippet: AnswerSnippet;
}

export interface DashboardRoleRow {
	role: RoleRef;
	byPlatform: { platform: GeoPlatform; mentionRate: MetricValue }[];
}

export interface DashboardData {
	ownName: string;
	promptSet: PromptSetRef | null;
	period: { from: string; to: string };
	previousPeriod: { from: string; to: string };
	platforms: DashboardPlatform[];
	roles: DashboardRoleRow[];
	conversation: DashboardConversation | null;
}

function daysBefore(day: string, days: number): string {
	return chinaDate(new Date(new Date(`${day}T00:00:00+08:00`).getTime() - days * DAY_MS));
}

/** The question set the dashboard reads: the frozen one answered most recently. */
async function currentQuestionSet(organizationId: string): Promise<PromptSetRef | null> {
	const [row] = await db
		.select({ id: geoPromptSets.id, name: geoPromptSets.name, version: geoPromptSets.version })
		.from(geoPromptSets)
		.innerJoin(geoObservations, eq(geoObservations.promptSetId, geoPromptSets.id))
		.where(and(eq(geoPromptSets.organizationId, organizationId), eq(geoPromptSets.status, "FROZEN")))
		.groupBy(geoPromptSets.id, geoPromptSets.name, geoPromptSets.version)
		.orderBy(desc(max(geoObservations.sampledAt)))
		.limit(1);
	return row ?? null;
}

async function ownBrandName(organizationId: string): Promise<string> {
	const [row] = await db
		.select({ name: geoBrandEntities.displayName })
		.from(geoBrandEntities)
		.where(
			and(
				eq(geoBrandEntities.organizationId, organizationId),
				eq(geoBrandEntities.kind, "OWN"),
				eq(geoBrandEntities.status, "ACTIVE"),
			),
		)
		.orderBy(asc(geoBrandEntities.createdAt))
		.limit(1);
	return row?.name ?? "我们";
}

async function spansByObservation(observationIds: readonly string[]): Promise<Map<string, GeoEvidenceSpan[]>> {
	const spans = new Map<string, GeoEvidenceSpan[]>();
	for (let index = 0; index < observationIds.length; index += 5000) {
		const rows = await db
			.select({ observationId: geoEvaluations.observationId, spans: geoEvaluations.evidenceSpans })
			.from(geoEvaluations)
			.where(
				and(
					inArray(geoEvaluations.observationId, observationIds.slice(index, index + 5000)),
					eq(geoEvaluations.isCurrent, true),
				),
			);
		for (const row of rows) spans.set(row.observationId, row.spans);
	}
	return spans;
}

async function rolesOfSet(
	organizationId: string,
	setId: string,
): Promise<{ order: RoleRef[]; byPrompt: Map<string, RoleRef> }> {
	const [items, roles] = await Promise.all([
		db
			.select({ promptId: geoPromptSetItems.promptId, labels: geoPromptSetItems.labels })
			.from(geoPromptSetItems)
			.where(and(eq(geoPromptSetItems.organizationId, organizationId), eq(geoPromptSetItems.setId, setId))),
		db
			.select({ id: geoBuyerRoles.id, title: geoBuyerRoles.title })
			.from(geoBuyerRoles)
			.where(eq(geoBuyerRoles.organizationId, organizationId))
			.orderBy(asc(geoBuyerRoles.priority), asc(geoBuyerRoles.title)),
	]);
	const byPrompt = new Map<string, RoleRef>();
	const used = new Map<string, RoleRef>();
	for (const item of items) {
		const id = item.labels.buyerRoleId;
		if (!id) continue;
		const role = {
			key: id,
			title: item.labels.buyerRoleTitle ?? roles.find((entry) => entry.id === id)?.title ?? "未命名角色",
		};
		byPrompt.set(item.promptId, role);
		used.set(id, role);
	}
	const rank = (key: string) => {
		const index = roles.findIndex((entry) => entry.id === key);
		return index < 0 ? roles.length : index;
	};
	return { order: [...used.values()].sort((a, b) => rank(a.key) - rank(b.key)), byPrompt };
}

function evaluatedOf(samples: readonly MetricSample[], cell: { platform: GeoPlatform; surfaceMode: GeoSurfaceMode }) {
	return evaluatedValidSamples(
		samples.filter((sample) => sample.platform === cell.platform && sample.surfaceMode === cell.surfaceMode),
	).evaluated;
}

function competitorRows(
	cell: CellMetrics,
	evaluated: readonly EvaluatedSample[],
	competitors: { entityId: string; name: string }[],
	ownName: string,
): DashboardCompetitorRow[] {
	const shares = new Map(
		shareOfVoice(evaluated, competitors, ownName).map((entry: VoiceShare) => [entry.entityId, entry.share]),
	);
	const rows: DashboardCompetitorRow[] = [
		{
			entityId: null,
			name: ownName,
			isOwn: true,
			mentionRate: cell.mentionRate,
			recommendationRate: cell.recommendationRate,
			share: shares.get(null) ?? null,
		},
		...cell.competitors.map((competitor) => ({
			entityId: competitor.entityId,
			name: competitor.name,
			isOwn: false,
			mentionRate: competitor.mentioned,
			recommendationRate: competitor.recommended,
			share: shares.get(competitor.entityId) ?? null,
		})),
	];
	const rate = (value: MetricValue) => (value.status === "OK" ? value.rate : -1);
	return rows.sort((a, b) => rate(b.mentionRate) - rate(a.mentionRate) || Number(b.isOwn) - Number(a.isOwn));
}

async function latestConversation(
	candidates: readonly EvaluatedSample[],
	spans: Map<string, GeoEvidenceSpan[]>,
): Promise<DashboardConversation | null> {
	const ordered = [...candidates].sort((a, b) => b.sampledAt.localeCompare(a.sampledAt));
	const pick =
		ordered.find(
			(sample) => sample.evaluation.brandMentioned || sample.evaluation.competitorHits.some((hit) => hit.mentioned),
		) ?? ordered[0];
	if (!pick) return null;
	const [row] = await db
		.select({ text: geoObservations.responseText })
		.from(geoObservations)
		.where(eq(geoObservations.id, pick.observationId));
	return {
		observationId: pick.observationId,
		platform: pick.platform,
		surfaceMode: pick.surfaceMode,
		question: pick.questionText,
		sampledAt: pick.sampledAt,
		brandMentioned: pick.evaluation.brandMentioned,
		competitorNames: pick.evaluation.competitorHits.flatMap((hit) => (hit.mentioned && hit.name ? [hit.name] : [])),
		snippet: answerSnippet(row?.text ?? "", spans.get(pick.observationId) ?? []),
	};
}

/**
 * The customer view: per platform, one capture mode on one question set, the current
 * four weeks against the four before. Failed answers are reported as not counted, never
 * as "not mentioned".
 */
export async function getDashboard(principal: GeoPrincipal): Promise<DashboardData> {
	assertGeoPermission(principal, "dashboard.read");
	const { organizationId } = principal;
	const to = chinaDate(new Date());
	const from = daysBefore(to, PERIOD_DAYS - 1);
	const previousPeriod = { from: daysBefore(from, PERIOD_DAYS), to: daysBefore(from, 1) };
	const trendFrom = daysBefore(to, TREND_WEEKS * 7 - 1);
	const [promptSet, ownName] = await Promise.all([currentQuestionSet(organizationId), ownBrandName(organizationId)]);
	const empty: DashboardData = {
		ownName,
		promptSet,
		period: { from, to },
		previousPeriod,
		platforms: [],
		roles: [],
		conversation: null,
	};
	if (!promptSet) return empty;

	const range = chinaDayRange(trendFrom, to);
	const data = await loadMetricData(db, organizationId, {
		from: range.start,
		to: range.end,
		promptSetId: promptSet.id,
	});
	const currentStart = chinaDayRange(from, to).start.toISOString();
	const previousRange = chinaDayRange(previousPeriod.from, previousPeriod.to);
	const inPrevious = (at: string) => at >= previousRange.start.toISOString() && at < previousRange.end.toISOString();
	const trendStart = chinaDayRange(trendFrom, to).start.toISOString();

	const current = computeInsights({
		samples: data.samples.filter((sample) => sample.sampledAt >= currentStart),
		slots: data.slots.filter((slot) => slot.sampledAt >= currentStart),
		competitors: data.competitors,
	});
	const previous = computeInsights({
		samples: data.samples.filter((sample) => inPrevious(sample.sampledAt)),
		slots: data.slots.filter((slot) => inPrevious(slot.sampledAt)),
		competitors: data.competitors,
	});
	const headline = pickHeadlineCells(current.cells);
	if (headline.length === 0) return empty;

	const currentSamples = data.samples.filter((sample) => sample.sampledAt >= currentStart);
	const evaluatedByCell = new Map(headline.map((cell) => [cell.platform, evaluatedOf(currentSamples, cell)]));
	const allEvaluated = [...evaluatedByCell.values()].flat();
	const [spans, roles] = await Promise.all([
		spansByObservation(allEvaluated.map((sample) => sample.observationId)),
		rolesOfSet(organizationId, promptSet.id),
	]);

	const platforms = headline.map((cell): DashboardPlatform => {
		const evaluated = evaluatedByCell.get(cell.platform) ?? [];
		const before = previous.cells.find(
			(candidate) => candidate.platform === cell.platform && candidate.surfaceMode === cell.surfaceMode,
		);
		const breakdown = cell.validSampleRate.breakdown;
		return {
			platform: cell.platform,
			surfaceMode: cell.surfaceMode,
			evaluated: cell.evaluatedSamples,
			notCounted: Math.max(0, breakdown.planned - breakdown.valid - breakdown.pending),
			mentionRate: cell.mentionRate,
			mentionChange: rateChange(cell.mentionRate, before?.mentionRate),
			recommendationRate: cell.recommendationRate,
			position: averagePosition(
				evaluated
					.filter((sample) => sample.evaluation.brandMentioned)
					.map((sample) => ownBrandPosition(spans.get(sample.observationId) ?? [])),
			),
			ownCitation: ownSiteCitation(evaluated),
			competitors: competitorRows(cell, evaluated, data.competitors, ownName),
			trend: weeklyMentionRate(
				data.samples.filter(
					(sample) =>
						sample.sampledAt >= trendStart &&
						sample.platform === cell.platform &&
						sample.surfaceMode === cell.surfaceMode,
				),
			),
		};
	});

	const roleRates = new Map(
		headline.map((cell) => [
			cell.platform,
			mentionRateByRole(evaluatedByCell.get(cell.platform) ?? [], (promptId) => roles.byPrompt.get(promptId) ?? null),
		]),
	);
	const roleOrder = [...roles.order, NO_ROLE].filter((role) =>
		[...roleRates.values()].some((rates) => rates.has(role.key)),
	);

	return {
		...empty,
		platforms,
		roles: roleOrder.map((role) => ({
			role,
			byPlatform: headline.map((cell) => ({
				platform: cell.platform,
				mentionRate: roleRates.get(cell.platform)?.get(role.key) ?? {
					status: "NO_DATA",
					numerator: 0,
					denominator: 0,
					reason: "没有这个角色的回答",
				},
			})),
		})),
		conversation: await latestConversation(allEvaluated, spans),
	};
}

export interface DashboardImprovement {
	id: string;
	kind: GeoRecommendationKind;
	title: string;
	summary: string;
	priority: GeoPriority;
}

export async function listTopImprovements(principal: GeoPrincipal): Promise<DashboardImprovement[]> {
	assertGeoPermission(principal, "recommendation.read");
	return db
		.select({
			id: geoRecommendations.id,
			kind: geoRecommendations.kind,
			title: geoRecommendations.title,
			summary: geoRecommendations.summary,
			priority: geoRecommendations.priority,
		})
		.from(geoRecommendations)
		.where(and(eq(geoRecommendations.organizationId, principal.organizationId), eq(geoRecommendations.status, "OPEN")))
		.orderBy(desc(geoRecommendations.impactScore), desc(geoRecommendations.updatedAt))
		.limit(3);
}

export interface SiteCompleteness {
	openFindings: Record<GeoFindingSeverity, number>;
	contentGaps: { total: number; items: { id: string; title: string }[] };
}

export async function getSiteCompleteness(principal: GeoPrincipal): Promise<SiteCompleteness> {
	assertGeoPermission(principal, "dashboard.read");
	const { organizationId } = principal;
	const [findings, gapCount, gaps] = await Promise.all([
		db
			.select({ severity: geoSiteAuditFindings.severity, value: count() })
			.from(geoSiteAuditFindings)
			.where(and(eq(geoSiteAuditFindings.organizationId, organizationId), eq(geoSiteAuditFindings.status, "OPEN")))
			.groupBy(geoSiteAuditFindings.severity),
		db.select({ value: count() }).from(geoRecommendations).where(contentGapWhere(organizationId)),
		db
			.select({ id: geoRecommendations.id, title: geoRecommendations.title })
			.from(geoRecommendations)
			.where(contentGapWhere(organizationId))
			.orderBy(desc(geoRecommendations.impactScore))
			.limit(4),
	]);
	const openFindings = Object.fromEntries(GEO_FINDING_SEVERITIES.map((severity) => [severity, 0])) as Record<
		GeoFindingSeverity,
		number
	>;
	for (const row of findings) openFindings[row.severity] = row.value;
	return { openFindings, contentGaps: { total: gapCount[0]?.value ?? 0, items: gaps } };
}

function contentGapWhere(organizationId: string) {
	return and(
		eq(geoRecommendations.organizationId, organizationId),
		eq(geoRecommendations.status, "OPEN"),
		eq(geoRecommendations.kind, "CONTENT_GAP"),
	);
}

export interface DashboardLayoutResult {
	cards: DashboardCard[];
	saved: boolean;
}

export async function getDashboardLayout(principal: GeoPrincipal): Promise<DashboardLayoutResult> {
	assertGeoPermission(principal, "dashboard.read");
	const [row] = await db
		.select({ cards: geoDashboardLayouts.cards })
		.from(geoDashboardLayouts)
		.where(
			and(
				eq(geoDashboardLayouts.organizationId, principal.organizationId),
				eq(geoDashboardLayouts.userId, principal.actorId),
			),
		);
	return { cards: normalizeDashboardLayout(row?.cards ?? null), saved: Boolean(row) };
}

export const dashboardLayoutSchema = z.object({
	cards: z
		.array(
			z.object({
				id: z.string().max(64),
				type: z.enum(DASHBOARD_CARD_TYPES),
			}),
		)
		.max(DASHBOARD_CARD_TYPES.length),
});

export async function saveDashboardLayout(
	principal: GeoPrincipal,
	input: z.infer<typeof dashboardLayoutSchema>,
): Promise<DashboardLayoutResult> {
	assertGeoPermission(principal, "dashboard.customize");
	const cards = normalizeDashboardLayout(input.cards);
	await db
		.insert(geoDashboardLayouts)
		.values({ organizationId: principal.organizationId, userId: principal.actorId, cards })
		.onConflictDoUpdate({
			target: [geoDashboardLayouts.organizationId, geoDashboardLayouts.userId],
			set: { cards, updatedAt: sql`now()` },
		});
	return { cards, saved: true };
}

export async function resetDashboardLayout(principal: GeoPrincipal): Promise<DashboardLayoutResult> {
	assertGeoPermission(principal, "dashboard.customize");
	await db
		.delete(geoDashboardLayouts)
		.where(
			and(
				eq(geoDashboardLayouts.organizationId, principal.organizationId),
				eq(geoDashboardLayouts.userId, principal.actorId),
			),
		);
	return { cards: normalizeDashboardLayout(null), saved: false };
}
