import {
	GEO_QUEUE,
	type GeoCitedContentType,
	type GeoPriority,
	type GeoPromptLabels,
	type GeoSiteEntityKind,
} from "@workspace/geo-domain";
import { hostOf } from "@workspace/geo-evidence";
import { loadCitationClassifications, loadRecommendationEvidence } from "@workspace/geo-reports/queries";
import {
	buildCitationClassificationPrompt,
	type ClaimIssue,
	citationClassificationSchema,
	classifyCitationByRules,
	type ExistingRecommendation,
	GEO_CITATION_CLASSIFY_BATCH,
	GEO_CITATION_RULES_CLASSIFIER,
	GEO_RECOMMENDATIONS_VERSION,
	generateRecommendations,
	type OpenFinding,
	type OwnProduct,
	type RecommendationCitation,
	type RecommendationPrompt,
	reconcileRecommendations,
	type SiteContentItem,
	siteDomainOf,
} from "@workspace/geo-reports/recommendations";
import { siteAuditRule } from "@workspace/geo-site-ingestion/audit/catalog";
import { db } from "@workspace/lib/db/db";
import {
	geoBrandEntities,
	geoBuyerRoles,
	geoCitationClassifications,
	geoEvaluations,
	geoObservationClaims,
	geoObservations,
	geoOrgSettings,
	geoProducts,
	geoPromptSetItems,
	geoPromptSets,
	geoRecommendations,
	geoSamplingBatches,
	geoSamplingRuns,
	geoSiteAuditFindings,
	geoSiteEntities,
	geoSiteEntitySources,
	geoSitePages,
	geoSitePageVersions,
	geoSiteSources,
} from "@workspace/lib/db/schema";
import { runStructuredCompletionPrompt } from "@workspace/lib/onboarding";
import { and, eq, gte, inArray, lt, notInArray, or, sql } from "drizzle-orm";
import { getBoss } from "../../boss";
import { defineGeoQueue, type GeoQueue } from "./queue";

export interface RecommendationJobData {
	organizationId?: string;
}

/** Bounds what one run may spend on the model; what is left over is classified on the next run. */
const MAX_CLASSIFY_CALLS = 5;
const FINDING_LIMIT = 5000;
const CLAIM_LIMIT = 2000;
const SITE_ENTITY_LIMIT = 5000;

const SITE_ENTITY_CONTENT: Partial<Record<GeoSiteEntityKind, GeoCitedContentType>> = {
	PRODUCT: "PRODUCT_SPEC",
	CASE: "CASE_STUDY",
	QUALIFICATION: "QUALIFICATION",
	COMPANY: "COMPANY_PROFILE",
	NEWS: "NEWS",
};

async function llmApproved(organizationId: string): Promise<boolean> {
	const [settings] = await db
		.select({ approved: geoOrgSettings.llmUseApproved })
		.from(geoOrgSettings)
		.where(eq(geoOrgSettings.organizationId, organizationId));
	return settings?.approved === true;
}

async function classifyWithModel(
	items: { url: string; title: string | null }[],
): Promise<{ url: string; title: string | null; contentType: GeoCitedContentType; classifier: string }[]> {
	const result: { url: string; title: string | null; contentType: GeoCitedContentType; classifier: string }[] = [];
	for (let call = 0; call < MAX_CLASSIFY_CALLS; call++) {
		const batch = items.slice(call * GEO_CITATION_CLASSIFY_BATCH, (call + 1) * GEO_CITATION_CLASSIFY_BATCH);
		if (batch.length === 0) break;
		try {
			const response = await runStructuredCompletionPrompt(
				buildCitationClassificationPrompt(batch),
				citationClassificationSchema,
			);
			const classifier = `llm:${response.modelVersion ?? "research"}`;
			for (const entry of response.object.items) {
				const item = batch[entry.index];
				if (item) result.push({ ...item, contentType: entry.contentType, classifier });
			}
		} catch (error) {
			console.warn(
				`[geo-recommendations] citation classification failed: ${error instanceof Error ? error.name : "error"}`,
			);
			break;
		}
	}
	return result;
}

/**
 * Cached classifications first, then the URL and title rules, then (only with the
 * organization's approval for model use) the model for what the rules cannot tell.
 * Only addresses and titles go out; no third-party page is fetched.
 */
async function classifyCitations(
	organizationId: string,
	citations: readonly RecommendationCitation[],
): Promise<Map<string, GeoCitedContentType>> {
	const titles = new Map<string, string | null>();
	for (const citation of citations) if (!titles.get(citation.url)) titles.set(citation.url, citation.title);
	const known = await loadCitationClassifications(db, [...titles.keys()]);
	const fresh: { url: string; title: string | null; contentType: GeoCitedContentType; classifier: string }[] = [];
	const unresolved: { url: string; title: string | null }[] = [];
	for (const [url, title] of titles) {
		if (known.has(url)) continue;
		const contentType = classifyCitationByRules(url, title);
		if (contentType) fresh.push({ url, title, contentType, classifier: GEO_CITATION_RULES_CLASSIFIER });
		else unresolved.push({ url, title });
	}
	if (unresolved.length > 0 && (await llmApproved(organizationId)))
		fresh.push(...(await classifyWithModel(unresolved)));
	if (fresh.length > 0) {
		await db
			.insert(geoCitationClassifications)
			.values(
				fresh.map((row) => ({
					url: row.url,
					domain: siteDomainOf(row.url) ?? hostOf(row.url) ?? "",
					contentType: row.contentType,
					title: row.title,
					classifier: row.classifier,
				})),
			)
			.onConflictDoNothing();
	}
	for (const row of fresh) known.set(row.url, row.contentType);
	return known;
}

async function promptsOf(organizationId: string, promptSetId: string): Promise<Map<string, RecommendationPrompt>> {
	const [items, roles] = await Promise.all([
		db
			.select({
				promptId: geoPromptSetItems.promptId,
				questionText: geoPromptSetItems.questionText,
				labels: geoPromptSetItems.labels,
			})
			.from(geoPromptSetItems)
			.where(and(eq(geoPromptSetItems.organizationId, organizationId), eq(geoPromptSetItems.setId, promptSetId))),
		db
			.select({ id: geoBuyerRoles.id, title: geoBuyerRoles.title, priority: geoBuyerRoles.priority })
			.from(geoBuyerRoles)
			.where(eq(geoBuyerRoles.organizationId, organizationId)),
	]);
	const roleById = new Map(roles.map((role) => [role.id, role]));
	return new Map(
		items.map((item) => {
			const labels = item.labels as Partial<GeoPromptLabels>;
			const role = labels.buyerRoleId ? roleById.get(labels.buyerRoleId) : undefined;
			return [
				item.promptId,
				{
					promptId: item.promptId,
					questionText: item.questionText,
					priority: (labels.priority as GeoPriority | undefined) ?? null,
					buyerRoleTitle: labels.buyerRoleTitle ?? role?.title ?? null,
					buyerRolePriority: role?.priority ?? null,
					productLine: labels.productLine ?? null,
				},
			];
		}),
	);
}

async function ownProducts(organizationId: string): Promise<OwnProduct[]> {
	return db
		.select({ name: geoProducts.name, model: geoProducts.model })
		.from(geoProducts)
		.innerJoin(geoBrandEntities, eq(geoBrandEntities.id, geoProducts.brandEntityId))
		.where(
			and(
				eq(geoProducts.organizationId, organizationId),
				eq(geoProducts.status, "ACTIVE"),
				eq(geoBrandEntities.kind, "OWN"),
				eq(geoBrandEntities.status, "ACTIVE"),
			),
		);
}

/** What the crawled site already has, by the entities its pages were parsed into. */
async function siteContent(organizationId: string): Promise<SiteContentItem[]> {
	const entities = await db
		.select({ id: geoSiteEntities.id, kind: geoSiteEntities.kind, title: geoSiteEntities.title })
		.from(geoSiteEntities)
		.where(
			and(
				eq(geoSiteEntities.organizationId, organizationId),
				notInArray(geoSiteEntities.status, ["REJECTED", "SOURCE_UNAVAILABLE"]),
			),
		)
		.limit(SITE_ENTITY_LIMIT);
	const typed = entities.filter((entity) => SITE_ENTITY_CONTENT[entity.kind]);
	const pages = new Map<string, { pageId: string; url: string }>();
	for (let index = 0; index < typed.length; index += 1000) {
		const rows = await db
			.select({ entityId: geoSiteEntitySources.entityId, pageId: geoSitePages.id, url: geoSitePages.normalizedUrl })
			.from(geoSiteEntitySources)
			.innerJoin(geoSitePageVersions, eq(geoSitePageVersions.id, geoSiteEntitySources.pageVersionId))
			.innerJoin(geoSitePages, eq(geoSitePages.id, geoSitePageVersions.pageId))
			.where(
				inArray(
					geoSiteEntitySources.entityId,
					typed.slice(index, index + 1000).map((entity) => entity.id),
				),
			);
		for (const row of rows) if (!pages.has(row.entityId)) pages.set(row.entityId, row);
	}
	return typed.map((entity) => ({
		contentType: SITE_ENTITY_CONTENT[entity.kind] as GeoCitedContentType,
		title: entity.title,
		pageId: pages.get(entity.id)?.pageId ?? null,
		url: pages.get(entity.id)?.url ?? null,
	}));
}

async function openFindings(organizationId: string): Promise<OpenFinding[]> {
	const rows = await db
		.select({
			id: geoSiteAuditFindings.id,
			ruleId: geoSiteAuditFindings.ruleId,
			recommendation: geoSiteAuditFindings.recommendation,
			severity: geoSiteAuditFindings.severity,
			pageId: geoSiteAuditFindings.pageId,
			pageUrl: geoSitePages.normalizedUrl,
		})
		.from(geoSiteAuditFindings)
		.leftJoin(geoSitePages, eq(geoSitePages.id, geoSiteAuditFindings.pageId))
		.where(and(eq(geoSiteAuditFindings.organizationId, organizationId), eq(geoSiteAuditFindings.status, "OPEN")))
		.limit(FINDING_LIMIT);
	return rows.map((row) => {
		const rule = siteAuditRule(row.ruleId);
		return {
			...row,
			ruleTitle: rule?.title ?? row.ruleId,
			recommendation: rule?.recommendation ?? row.recommendation,
		};
	});
}

async function wrongClaims(
	organizationId: string,
	promptSetId: string,
	window: { from: Date; to: Date },
): Promise<ClaimIssue[]> {
	const c = geoObservationClaims;
	return db
		.select({
			id: c.id,
			observationId: c.observationId,
			claimText: c.claimText,
			kind: c.claimKind,
			extractedValue: c.extractedValue,
			referenceValue: c.referenceValue,
			verdict: c.verdict,
			matchStatus: c.matchStatus,
			assertionId: c.assertionId,
		})
		.from(c)
		.innerJoin(geoEvaluations, and(eq(geoEvaluations.id, c.evaluationId), eq(geoEvaluations.isCurrent, true)))
		.innerJoin(geoObservations, eq(geoObservations.id, c.observationId))
		.where(
			and(
				eq(c.organizationId, organizationId),
				eq(geoObservations.promptSetId, promptSetId),
				gte(geoObservations.sampledAt, window.from),
				lt(geoObservations.sampledAt, window.to),
				or(eq(c.verdict, "ERROR"), eq(c.matchStatus, "MISMATCH")),
			),
		)
		.limit(CLAIM_LIMIT);
}

export async function generateForOrganization(organizationId: string) {
	const evidence = await loadRecommendationEvidence(db, organizationId);
	const setId = evidence.promptSet?.id ?? null;
	const [classifications, prompts, products, content, findings, claims] = await Promise.all([
		classifyCitations(organizationId, evidence.citations),
		setId ? promptsOf(organizationId, setId) : new Map<string, RecommendationPrompt>(),
		ownProducts(organizationId),
		siteContent(organizationId),
		openFindings(organizationId),
		setId ? wrongClaims(organizationId, setId, evidence) : [],
	]);
	const drafts = generateRecommendations({
		samples: evidence.samples,
		competitors: evidence.competitors,
		prompts,
		citations: evidence.citations,
		classifications,
		siteContent: content,
		ownProducts: products,
		findings,
		claims,
	});

	return db.transaction(async (tx) => {
		await tx.execute(
			sql`select pg_advisory_xact_lock(hashtextextended(${`geo-recommendations:${organizationId}`}, 0))`,
		);
		const existing = await tx
			.select({
				id: geoRecommendations.id,
				kind: geoRecommendations.kind,
				subjectKey: geoRecommendations.subjectKey,
				status: geoRecommendations.status,
				taskId: geoRecommendations.taskId,
				evidence: geoRecommendations.evidence,
			})
			.from(geoRecommendations)
			.where(eq(geoRecommendations.organizationId, organizationId));
		const { writes, staleIds } = reconcileRecommendations(existing as ExistingRecommendation[], drafts);
		const now = new Date();
		for (const write of writes) {
			const fields = {
				title: write.draft.title,
				summary: write.draft.summary,
				contentType: write.draft.contentType,
				priority: write.draft.priority,
				impactScore: write.draft.impactScore,
				evidence: write.draft.evidence,
				status: write.status,
				generatorVersion: GEO_RECOMMENDATIONS_VERSION,
				updatedAt: now,
			};
			if (write.existingId) {
				await tx
					.update(geoRecommendations)
					.set(write.reopened ? { ...fields, taskId: null, decidedBy: null, decidedAt: null } : fields)
					.where(eq(geoRecommendations.id, write.existingId));
			} else {
				await tx
					.insert(geoRecommendations)
					.values({ organizationId, kind: write.draft.kind, subjectKey: write.draft.subjectKey, ...fields });
			}
		}
		if (staleIds.length > 0) await tx.delete(geoRecommendations).where(inArray(geoRecommendations.id, staleIds));
		const reopened = writes.filter((write) => write.reopened).length;
		console.log(
			`[geo-recommendations] ${organizationId}: ${writes.length} items (${reopened} reopened), ${staleIds.length} removed`,
		);
		return { items: writes.length, reopened, removed: staleIds.length, promptSetId: setId };
	});
}

function sendGeneration(organizationId: string) {
	return getBoss().send(
		GEO_QUEUE.recommendations,
		{ organizationId },
		{ singletonKey: `recommendations:${organizationId}`, singletonSeconds: 5 * 60 },
	);
}

/** Daily: every organization with a frozen question set or an authorized site. */
async function queueAllOrganizations(): Promise<{ queued: number }> {
	const rows = await db.execute<{ organization_id: string }>(sql`
		select organization_id from ${geoPromptSets} where status = 'FROZEN'
		union
		select organization_id from ${geoSiteSources} where enabled = true
	`);
	for (const row of rows.rows) await sendGeneration(row.organization_id);
	return { queued: rows.rows.length };
}

/**
 * Called after each automatic evaluation: once the answer's batch has settled and none of
 * its readable answers is still waiting for an evaluation, the recommendations are rebuilt.
 */
export async function queueRecommendationsAfterEvaluation(organizationId: string, observationId: string) {
	const [row] = await db
		.select({
			batchId: geoSamplingBatches.id,
			pending: sql<boolean>`exists (
				select 1 from ${geoObservations} o
				join ${geoSamplingRuns} r on r.id = o.run_id
				left join ${geoEvaluations} e on e.observation_id = o.id
				where r.batch_id = ${geoSamplingBatches.id}
					and o.status in ('VALID', 'PARTIAL')
					and o.response_text is not null
					and e.id is null
			)`,
		})
		.from(geoObservations)
		.innerJoin(geoSamplingRuns, eq(geoSamplingRuns.id, geoObservations.runId))
		.innerJoin(geoSamplingBatches, eq(geoSamplingBatches.id, geoSamplingRuns.batchId))
		.where(
			and(
				eq(geoObservations.id, observationId),
				eq(geoObservations.organizationId, organizationId),
				inArray(geoSamplingBatches.status, ["COMPLETED", "PARTIAL", "FAILED"]),
			),
		);
	if (row && !row.pending) await sendGeneration(organizationId);
}

export const GEO_RECOMMENDATION_QUEUES: GeoQueue[] = [
	defineGeoQueue<RecommendationJobData>({
		name: GEO_QUEUE.recommendations,
		options: { retryLimit: 1, retryDelay: 120, expireInSeconds: 30 * 60 },
		work: { batchSize: 1, localConcurrency: 1 },
		handler: async ([job]) =>
			job.data.organizationId ? generateForOrganization(job.data.organizationId) : queueAllOrganizations(),
		// 03:30 China time, after the night's sampling has been evaluated.
		schedule: { cron: "30 19 * * *" },
	}),
];
