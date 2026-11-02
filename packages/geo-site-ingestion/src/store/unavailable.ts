import {
	assertionTransition,
	type GeoAssertionStatus,
	type GeoPrincipal,
	type GeoRiskLevel,
	type GeoSitePageStatus,
	transitionActorOf,
} from "@workspace/geo-domain";
import type { DbConnection } from "@workspace/lib/db/db-connection";
import {
	geoAssertionSources,
	geoKnowledgeAssertions,
	geoSiteEntities,
	geoSiteEntitySources,
	geoSitePages,
	geoSitePageVersions,
} from "@workspace/lib/db/schema";
import { writeGeoAudit } from "@workspace/lib/geo/audit";
import { createOptimizationTask } from "@workspace/lib/geo/tasks";
import { and, eq, inArray, notInArray, sql } from "drizzle-orm";

const UNAVAILABLE: GeoSitePageStatus[] = ["GONE", "REDIRECTED", "BLOCKED"];

type PageRow = typeof geoSitePages.$inferSelect;

/** Whether anything other than the given pages, still live, or an uploaded document backs the assertion. */
async function hasOtherLiveSource(tx: DbConnection, assertionId: string, pageId: string): Promise<boolean> {
	const [row] = await tx
		.select({ found: sql<number>`1` })
		.from(geoAssertionSources)
		.leftJoin(geoSitePageVersions, eq(geoSitePageVersions.id, geoAssertionSources.pageVersionId))
		.leftJoin(geoSitePages, eq(geoSitePages.id, geoSitePageVersions.pageId))
		.where(
			and(
				eq(geoAssertionSources.assertionId, assertionId),
				sql`(${geoAssertionSources.assetId} is not null or (${geoSitePages.id} <> ${pageId} and ${geoSitePages.status} not in ('GONE', 'REDIRECTED', 'BLOCKED')))`,
			),
		)
		.limit(1);
	return Boolean(row);
}

type AssertionRow = { id: string; status: GeoAssertionStatus; riskLevel: GeoRiskLevel };

async function assertionsOfPage(tx: DbConnection, page: PageRow): Promise<AssertionRow[]> {
	return tx
		.selectDistinct({
			id: geoKnowledgeAssertions.id,
			status: geoKnowledgeAssertions.status,
			riskLevel: geoKnowledgeAssertions.riskLevel,
		})
		.from(geoAssertionSources)
		.innerJoin(geoSitePageVersions, eq(geoSitePageVersions.id, geoAssertionSources.pageVersionId))
		.innerJoin(geoKnowledgeAssertions, eq(geoKnowledgeAssertions.id, geoAssertionSources.assertionId))
		.where(and(eq(geoSitePageVersions.pageId, page.id), eq(geoAssertionSources.organizationId, page.organizationId)));
}

/** Only candidates still awaiting review, and only when nothing else backs them, become source-unavailable. */
async function markOrphanedCandidates(
	tx: DbConnection,
	system: GeoPrincipal,
	page: PageRow,
	assertions: AssertionRow[],
): Promise<string[]> {
	const marked: string[] = [];
	for (const assertion of assertions.filter((entry) => entry.status === "PENDING_REVIEW")) {
		if (await hasOtherLiveSource(tx, assertion.id, page.id)) continue;
		const result = assertionTransition({
			assertion: { status: assertion.status, riskLevel: assertion.riskLevel, authorId: null },
			action: "MARK_SOURCE_UNAVAILABLE",
			actor: transitionActorOf(system),
		});
		if (!result.ok) continue;
		await tx
			.update(geoKnowledgeAssertions)
			.set({ status: result.to })
			.where(and(eq(geoKnowledgeAssertions.id, assertion.id), eq(geoKnowledgeAssertions.status, "PENDING_REVIEW")));
		marked.push(assertion.id);
	}
	return marked;
}

async function markOrphanedEntities(tx: DbConnection, page: PageRow): Promise<void> {
	const entityIds = (
		await tx
			.selectDistinct({ id: geoSiteEntitySources.entityId })
			.from(geoSiteEntitySources)
			.innerJoin(geoSitePageVersions, eq(geoSitePageVersions.id, geoSiteEntitySources.pageVersionId))
			.where(eq(geoSitePageVersions.pageId, page.id))
	).map((row) => row.id);
	if (entityIds.length === 0) return;
	const stillBacked = await tx
		.selectDistinct({ id: geoSiteEntitySources.entityId })
		.from(geoSiteEntitySources)
		.innerJoin(geoSitePageVersions, eq(geoSitePageVersions.id, geoSiteEntitySources.pageVersionId))
		.innerJoin(geoSitePages, eq(geoSitePages.id, geoSitePageVersions.pageId))
		.where(and(inArray(geoSiteEntitySources.entityId, entityIds), notInArray(geoSitePages.status, UNAVAILABLE)));
	const orphaned = entityIds.filter((id) => !stillBacked.some((row) => row.id === id));
	if (orphaned.length === 0) return;
	await tx
		.update(geoSiteEntities)
		.set({ status: "SOURCE_UNAVAILABLE" })
		.where(and(inArray(geoSiteEntities.id, orphaned), eq(geoSiteEntities.status, "CANDIDATE")));
}

async function createReviewTask(
	tx: DbConnection,
	system: GeoPrincipal,
	page: PageRow,
	kind: "GONE" | "REDIRECTED",
	assertions: AssertionRow[],
): Promise<string> {
	const evidence = assertions
		.filter((assertion) => assertion.status === "APPROVED" || assertion.status === "PENDING_REVIEW")
		.map((assertion) => assertion.id);
	const label = kind === "GONE" ? "已失效" : "已重定向";
	const { task } = await createOptimizationTask(tx, system, {
		title: `官网页面${label}，待核查：${page.normalizedUrl}`.slice(0, 300),
		kind: "SITE_REVISION",
		sourceKind: evidence.length > 0 ? "ASSERTION" : "MANUAL",
		sourceRef: `site-page-unavailable:${page.id}`,
		priority: evidence.length > 0 ? "P1" : "P2",
		riskLevel: assertions.some((assertion) => assertion.riskLevel === "HIGH") ? "HIGH" : "NORMAL",
		recommendedAction:
			kind === "GONE"
				? "确认页面是否有意下线；若内容迁移，请登记新网址并核对相关事实是否仍然有效。"
				: `页面已跳转到 ${page.canonicalUrl ?? "新地址"}，请确认新页面内容与已登记事实一致。`,
		evidence: { assertionIds: evidence },
		comment: `采集发现页面${label}（HTTP ${page.httpStatus ?? "-"}），历史版本与来源均已保留。`,
	});
	return task.id;
}

/**
 * UAT-19. Versions and sources stay exactly as they were. Candidates that only
 * this page backed are marked source-unavailable; approved facts are never
 * touched by the crawler, they go into a review task instead, so a person
 * decides whether the fact still stands.
 */
export async function markPageUnavailable(
	db: DbConnection,
	system: GeoPrincipal,
	page: PageRow,
	kind: "GONE" | "REDIRECTED",
): Promise<{ taskId: string | null }> {
	return db.transaction(async (tx) => {
		const assertions = await assertionsOfPage(tx, page);
		const marked = await markOrphanedCandidates(tx, system, page, assertions);
		await markOrphanedEntities(tx, page);
		const [hasVersion] = await tx
			.select({ id: geoSitePageVersions.id })
			.from(geoSitePageVersions)
			.where(eq(geoSitePageVersions.pageId, page.id))
			.limit(1);
		const taskId = hasVersion ? await createReviewTask(tx, system, page, kind, assertions) : null;
		await writeGeoAudit(tx, {
			principal: system,
			action: "site.page.unavailable",
			entityType: "site_page",
			entityId: page.id,
			after: { status: page.status },
			metadata: {
				kind,
				url: page.normalizedUrl,
				markedAssertions: marked.length,
				assertions: assertions.length,
				taskId,
			},
		});
		return { taskId };
	});
}
