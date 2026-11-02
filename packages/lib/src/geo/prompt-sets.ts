import { GeoError, type GeoPromptLabels } from "@workspace/geo-domain";
import { and, asc, eq } from "drizzle-orm";
import type { DbConnection } from "../db/db-connection";
import { geoPromptSetItems, geoPromptSets } from "../db/schema-geo";

export interface GeoFrozenPromptSetItem {
	promptId: string;
	promptRevision: number;
	questionText: string;
	labels: GeoPromptLabels;
}

export interface GeoFrozenPromptSet {
	id: string;
	organizationId: string;
	name: string;
	version: number;
	parentSetId: string | null;
	frozenAt: Date;
	frozenBy: string;
	items: GeoFrozenPromptSetItem[];
}

/**
 * The snapshot a sampling round must run against: the question text comes from the set
 * item, never from the live prompt. Extended prompts are stored for reference but stay
 * out of routine monitoring unless a caller asks for them.
 */
export async function getFrozenPromptSet(
	db: DbConnection,
	organizationId: string,
	setId: string,
	options: { includeExtended?: boolean } = {},
): Promise<GeoFrozenPromptSet> {
	const [set] = await db
		.select()
		.from(geoPromptSets)
		.where(and(eq(geoPromptSets.organizationId, organizationId), eq(geoPromptSets.id, setId)))
		.limit(1);
	if (!set) throw new GeoError("NOT_FOUND", "测试集不存在");
	if (set.status !== "FROZEN" || !set.frozenAt || !set.frozenBy) {
		throw new GeoError("CONFLICT", "测试集尚未冻结，不能用于监测轮次");
	}

	const rows = await db
		.select({
			promptId: geoPromptSetItems.promptId,
			promptRevision: geoPromptSetItems.promptRevision,
			questionText: geoPromptSetItems.questionText,
			labels: geoPromptSetItems.labels,
		})
		.from(geoPromptSetItems)
		.where(and(eq(geoPromptSetItems.organizationId, organizationId), eq(geoPromptSetItems.setId, setId)))
		.orderBy(asc(geoPromptSetItems.createdAt), asc(geoPromptSetItems.promptId));

	return {
		id: set.id,
		organizationId: set.organizationId,
		name: set.name,
		version: set.version,
		parentSetId: set.parentSetId,
		frozenAt: set.frozenAt,
		frozenBy: set.frozenBy,
		items: options.includeExtended ? rows : rows.filter((row) => row.labels.tier === "CORE"),
	};
}
