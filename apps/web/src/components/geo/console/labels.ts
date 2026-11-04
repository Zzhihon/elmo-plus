import { GEO_PLATFORM_LABELS, type GeoPlatform, type GeoSurfaceMode } from "@workspace/geo-domain";
import type { ConsoleOutcome } from "@/server/geo/console-core";

const MODE_LABELS: Record<GeoSurfaceMode, string> = {
	LIVE_SURFACE: "真实产品端",
	BROWSER_AGENT: "浏览器模拟用户",
	MODEL_API: "模型 API",
	MANUAL_EVIDENCE: "人工记录",
};

export function channelLabel(platform: GeoPlatform, surfaceMode: GeoSurfaceMode): string {
	return `${GEO_PLATFORM_LABELS[platform]} · ${MODE_LABELS[surfaceMode]}`;
}

const RECOMMENDATION_WORDS = {
	RECOMMENDED: "被推荐",
	MENTIONED_ONLY: "只是提到，没有推荐",
	NEGATIVE: "带有负面评价",
	NOT_MENTIONED: null,
} as const;

/** One line a client can read at a glance: were we there, where, and how were we described. */
export function outcomeParts(outcome: ConsoleOutcome, brandName: string): string[] {
	if (!outcome.brandMentioned) {
		const competitors = outcome.competitorsMentioned;
		return [
			`没有提到${brandName}`,
			...(competitors.length > 0 ? [`提到了 ${competitors.length} 个竞品：${competitors.join("、")}`] : []),
		];
	}
	const parts = [`提到了${brandName}`];
	if (outcome.brandRank !== null) parts.push(`排第 ${outcome.brandRank} 位`);
	const words = RECOMMENDATION_WORDS[outcome.recommendation];
	if (words) parts.push(words);
	return parts;
}

export const consoleKeys = {
	all: (organizationId: string) => ["geo", organizationId, "console"] as const,
	questions: (organizationId: string) => ["geo", organizationId, "console", "questions"] as const,
	samples: (organizationId: string, promptId: string) =>
		["geo", organizationId, "console", "samples", promptId] as const,
	answer: (organizationId: string, observationId: string) =>
		["geo", organizationId, "console", "answer", observationId] as const,
	live: (organizationId: string) => ["geo", organizationId, "console", "live"] as const,
};
