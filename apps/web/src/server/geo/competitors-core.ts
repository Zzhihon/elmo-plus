import {
	assertGeoPermission,
	GEO_DISCOVERY_QUESTIONS,
	GEO_DISCOVERY_SET_NAME,
	GEO_QUEUE,
	GeoError,
	type GeoPlatform,
	type GeoPrincipal,
} from "@workspace/geo-domain";
import { db } from "@workspace/lib/db/db";
import type { DbConnection } from "@workspace/lib/db/db-connection";
import {
	geoBrandEntities,
	geoCompetitorCandidates,
	geoObservations,
	geoOrgSettings,
	geoSamplingTargets,
} from "@workspace/lib/db/schema";
import { writeGeoAudit } from "@workspace/lib/geo/audit";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { enqueueGeoJob } from "@/lib/geo/enqueue";
import { brandInputSchema, insertBrandInTransaction } from "./profile-core";
import { assertTargetRunnable, createSamplingBatch } from "./sampling-core";
import { adoptCatalogQuestions } from "./setup-core";

export const discoveryInputSchema = z.object({
	/** Ask the discovery questions on every runnable platform first, then read those answers too. */
	sampleFirst: z.boolean().default(false),
});

export interface GeoCompetitorQuote {
	observationId: string;
	platform: GeoPlatform;
	question: string;
	quote: string;
}

export interface GeoCompetitorCandidateView {
	id: string;
	name: string;
	aliases: string[];
	mentionCount: number;
	observationCount: number;
	platforms: GeoPlatform[];
	lastSeenAt: string | null;
	quotes: GeoCompetitorQuote[];
}

export interface GeoCompetitorsView {
	competitors: { id: string; name: string; aliases: string[] }[];
	candidates: GeoCompetitorCandidateView[];
	dismissedCount: number;
	/** Discovery sends answers to a model, which the organization has to have approved. */
	llmApproved: boolean;
}

const QUOTE_RADIUS = 60;

/** The sentence-sized stretch of the answer around the first time the name appears. */
function quoteAround(text: string, names: readonly string[]): string | null {
	for (const name of names) {
		const at = text.indexOf(name);
		if (at < 0) continue;
		const start = Math.max(0, at - QUOTE_RADIUS);
		const end = Math.min(text.length, at + name.length + QUOTE_RADIUS);
		const snippet = text
			.slice(start, end)
			.replace(/(\*\*|__|`|#{1,6}\s)/g, "")
			.replace(/\s+/g, " ")
			.trim();
		return `${start > 0 ? "…" : ""}${snippet}${end < text.length ? "…" : ""}`;
	}
	return null;
}

async function llmApproved(organizationId: string): Promise<boolean> {
	const [settings] = await db
		.select({ approved: geoOrgSettings.llmUseApproved })
		.from(geoOrgSettings)
		.where(eq(geoOrgSettings.organizationId, organizationId));
	return settings?.approved === true;
}

export async function listCompetitors(principal: GeoPrincipal): Promise<GeoCompetitorsView> {
	assertGeoPermission(principal, "competitor.read");
	const organizationId = principal.organizationId;
	const [competitors, candidates, dismissed, approved] = await Promise.all([
		db
			.select({ id: geoBrandEntities.id, name: geoBrandEntities.displayName, aliases: geoBrandEntities.aliases })
			.from(geoBrandEntities)
			.where(
				and(
					eq(geoBrandEntities.organizationId, organizationId),
					eq(geoBrandEntities.kind, "COMPETITOR"),
					eq(geoBrandEntities.status, "ACTIVE"),
				),
			)
			.orderBy(asc(geoBrandEntities.createdAt)),
		db
			.select()
			.from(geoCompetitorCandidates)
			.where(
				and(eq(geoCompetitorCandidates.organizationId, organizationId), eq(geoCompetitorCandidates.status, "PENDING")),
			)
			.orderBy(desc(geoCompetitorCandidates.mentionCount), asc(geoCompetitorCandidates.name))
			.limit(100),
		db
			.select({ id: geoCompetitorCandidates.id })
			.from(geoCompetitorCandidates)
			.where(
				and(
					eq(geoCompetitorCandidates.organizationId, organizationId),
					eq(geoCompetitorCandidates.status, "DISMISSED"),
				),
			),
		llmApproved(organizationId),
	]);

	const sampleIds = [...new Set(candidates.flatMap((candidate) => candidate.sampleObservationIds))];
	const observations =
		sampleIds.length === 0
			? []
			: await db
					.select({
						id: geoObservations.id,
						platform: geoObservations.platform,
						questionText: geoObservations.questionText,
						responseText: geoObservations.responseText,
					})
					.from(geoObservations)
					.where(and(eq(geoObservations.organizationId, organizationId), inArray(geoObservations.id, sampleIds)));
	const byId = new Map(observations.map((row) => [row.id, row]));

	return {
		competitors,
		candidates: candidates.map((candidate) => ({
			id: candidate.id,
			name: candidate.name,
			aliases: candidate.aliases,
			mentionCount: candidate.mentionCount,
			observationCount: candidate.observationCount,
			platforms: candidate.platforms,
			lastSeenAt: candidate.lastSeenAt?.toISOString() ?? null,
			quotes: candidate.sampleObservationIds.flatMap((id) => {
				const observation = byId.get(id);
				const quote = observation?.responseText
					? quoteAround(observation.responseText, [candidate.name, ...candidate.aliases])
					: null;
				return observation && quote
					? [{ observationId: id, platform: observation.platform, question: observation.questionText, quote }]
					: [];
			}),
		})),
		dismissedCount: dismissed.length,
		llmApproved: approved,
	};
}

async function runnableTargetIds(principal: GeoPrincipal): Promise<string[]> {
	const targets = await db
		.select()
		.from(geoSamplingTargets)
		.where(and(eq(geoSamplingTargets.organizationId, principal.organizationId), eq(geoSamplingTargets.enabled, true)));
	return targets
		.filter((target) => {
			try {
				assertTargetRunnable(target);
				return true;
			} catch {
				return false;
			}
		})
		.map((target) => target.id);
}

export interface GeoDiscoveryStartResult {
	queued: boolean;
	sampledBatchId: string | null;
}

export async function startCompetitorDiscovery(
	principal: GeoPrincipal,
	raw: z.input<typeof discoveryInputSchema>,
): Promise<GeoDiscoveryStartResult> {
	assertGeoPermission(principal, "competitor.discover");
	const { sampleFirst } = discoveryInputSchema.parse(raw);
	if (!(await llmApproved(principal.organizationId))) {
		throw new GeoError("VALIDATION_ERROR", "发现竞品需要先由管理员在设置中批准使用大模型");
	}

	let batchId: string | null = null;
	if (sampleFirst) {
		const set = await adoptCatalogQuestions(principal, GEO_DISCOVERY_SET_NAME, GEO_DISCOVERY_QUESTIONS);
		const targetIds = await runnableTargetIds(principal);
		if (targetIds.length === 0) throw new GeoError("TARGET_UNAVAILABLE", "没有可用的 AI 平台，请先在采样页配置并验证");
		const day = new Date().toISOString().slice(0, 10);
		const result = await createSamplingBatch(principal, {
			promptSetId: set.setId,
			targetIds,
			repeatCount: 1,
			includeExtended: true,
			idempotencyKey: `competitor-discovery:${set.setId}:${day}`,
		});
		batchId = result.batch.id;
	}

	const jobId = await enqueueGeoJob(
		GEO_QUEUE.competitorDiscovery,
		{ organizationId: principal.organizationId, ...(batchId && { batchId }) },
		{ singletonKey: `competitor-discovery:${principal.organizationId}` },
	);
	await writeGeoAudit(db, {
		principal,
		action: "competitor.discover",
		entityType: "competitor_candidate",
		entityId: principal.organizationId,
		metadata: { sampleFirst, batchId, jobId },
	});
	return { queued: jobId !== null, sampledBatchId: batchId };
}

async function loadCandidateForDecision(tx: DbConnection, principal: GeoPrincipal, id: string) {
	const [candidate] = await tx
		.select()
		.from(geoCompetitorCandidates)
		.where(
			and(eq(geoCompetitorCandidates.organizationId, principal.organizationId), eq(geoCompetitorCandidates.id, id)),
		)
		.for("update");
	if (!candidate) throw new GeoError("NOT_FOUND", "候选竞品不存在");
	if (candidate.status === "ACCEPTED") throw new GeoError("CONFLICT", "该竞品已加入");
	return candidate;
}

/** Accepting records the competitor in the brand dictionary, so later answers are judged against it. */
export async function acceptCompetitorCandidate(principal: GeoPrincipal, id: string): Promise<{ brandId: string }> {
	assertGeoPermission(principal, "competitor.decide");
	return db.transaction(async (tx) => {
		const candidate = await loadCandidateForDecision(tx, principal, id);
		const brand = await insertBrandInTransaction(
			tx,
			principal,
			brandInputSchema.parse({
				kind: "COMPETITOR",
				displayName: candidate.name,
				aliases: candidate.aliases,
				domains: candidate.domains,
				changeNote: `从 AI 回答中发现并确认竞品“${candidate.name}”`,
			}),
		);
		const now = new Date();
		const [after] = await tx
			.update(geoCompetitorCandidates)
			.set({
				status: "ACCEPTED",
				brandEntityId: brand.id,
				decidedBy: principal.actorId,
				decidedAt: now,
				updatedAt: now,
			})
			.where(eq(geoCompetitorCandidates.id, candidate.id))
			.returning();
		await writeGeoAudit(tx, {
			principal,
			action: "competitor_candidate.accept",
			entityType: "competitor_candidate",
			entityId: candidate.id,
			before: candidate,
			after,
			metadata: { brandId: brand.id },
		});
		return { brandId: brand.id };
	});
}

export async function dismissCompetitorCandidate(principal: GeoPrincipal, id: string): Promise<void> {
	assertGeoPermission(principal, "competitor.decide");
	await db.transaction(async (tx) => {
		const candidate = await loadCandidateForDecision(tx, principal, id);
		if (candidate.status === "DISMISSED") return;
		const now = new Date();
		const [after] = await tx
			.update(geoCompetitorCandidates)
			.set({ status: "DISMISSED", decidedBy: principal.actorId, decidedAt: now, updatedAt: now })
			.where(eq(geoCompetitorCandidates.id, candidate.id))
			.returning();
		await writeGeoAudit(tx, {
			principal,
			action: "competitor_candidate.dismiss",
			entityType: "competitor_candidate",
			entityId: candidate.id,
			before: candidate,
			after,
		});
	});
}
