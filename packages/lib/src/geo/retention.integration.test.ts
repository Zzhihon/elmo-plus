import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db } from "../db/db";
import { organization } from "../db/schema-auth";
import {
	geoAssertionSources,
	geoAuditLogs,
	geoDictionaryVersions,
	geoEvaluations,
	geoEvidenceUploads,
	geoKnowledgeAssertions,
	geoObservationCitations,
	geoObservationClaims,
	geoObservations,
	geoOptimizationTasks,
	geoOrgSettings,
	geoPromptRevisions,
	geoPromptSetItems,
	geoPromptSets,
	geoPrompts,
	geoSamplingBatches,
	geoSamplingRuns,
	geoSamplingTargets,
	geoSiteCrawlItems,
	geoSiteCrawlRuns,
	geoSitePages,
	geoSitePageVersions,
	geoSiteQaItems,
	geoSiteQaSamples,
	geoSiteSources,
	geoTaskEvents,
	geoTaskEvidence,
} from "../db/schema-geo";
import { findGeoApprovalTimeouts, geoRetentionConfigs } from "./maintenance";
import { purgeExpiredGeoData } from "./retention";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-09-01T00:00:00Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY);

async function createOrganization(): Promise<string> {
	const id = `org-${randomUUID()}`;
	await db.insert(organization).values({ id, name: "示例电气", slug: id, createdAt: new Date() });
	return id;
}

async function createPrompt(organizationId: string) {
	const [prompt] = await db
		.insert(geoPrompts)
		.values({ organizationId, question: "高低压开关柜哪家好？", createdBy: "user-a" })
		.returning();
	await db.insert(geoPromptRevisions).values({
		organizationId,
		promptId: prompt.id,
		revision: 1,
		snapshot: { question: prompt.question } as never,
		editorId: "user-a",
	});
	return prompt;
}

async function createTarget(organizationId: string) {
	const [target] = await db
		.insert(geoSamplingTargets)
		.values({ organizationId, platform: "deepseek", surfaceMode: "MODEL_API", provider: "openai", createdBy: "user-a" })
		.returning();
	return target;
}

async function insertObservation(
	organizationId: string,
	promptId: string,
	targetId: string,
	sampledAt: Date,
	extra: Partial<typeof geoObservations.$inferInsert> = {},
) {
	const [row] = await db
		.insert(geoObservations)
		.values({
			organizationId,
			promptId,
			promptRevision: 1,
			questionText: "高低压开关柜哪家好？",
			targetId,
			platform: "deepseek",
			surfaceMode: "MODEL_API",
			status: "VALID",
			responseText: "示例电气是常见选择。",
			sampledAt,
			...extra,
		})
		.returning();
	return row;
}

async function rejected(statement: Promise<unknown>): Promise<string> {
	try {
		await statement;
	} catch (error) {
		const cause = (error as { cause?: { message?: string } }).cause;
		return cause?.message ?? (error as Error).message;
	}
	throw new Error("statement was expected to fail");
}

describe("append-only tables", () => {
	let organizationId: string;
	let observationId: string;
	let promptId: string;

	beforeAll(async () => {
		organizationId = await createOrganization();
		const prompt = await createPrompt(organizationId);
		promptId = prompt.id;
		const target = await createTarget(organizationId);
		observationId = (await insertObservation(organizationId, prompt.id, target.id, NOW)).id;
	});

	it("refuses to change or remove an observation", async () => {
		expect(
			await rejected(
				db.update(geoObservations).set({ responseText: "改写" }).where(eq(geoObservations.id, observationId)),
			),
		).toMatch(/append-only|cannot/i);
		expect(await rejected(db.delete(geoObservations).where(eq(geoObservations.id, observationId)))).toMatch(
			/append-only|cannot/i,
		);
	});

	it("refuses to change audit rows, prompt revisions, dictionary versions and task events", async () => {
		const [audit] = await db
			.insert(geoAuditLogs)
			.values({
				organizationId,
				actorId: "user-a",
				actorKind: "user",
				action: "test.write",
				entityType: "test",
				entityId: "1",
			})
			.returning();
		await rejected(db.update(geoAuditLogs).set({ action: "test.rewrite" }).where(eq(geoAuditLogs.id, audit.id)));
		await rejected(db.delete(geoAuditLogs).where(eq(geoAuditLogs.id, audit.id)));
		await rejected(
			db.update(geoPromptRevisions).set({ editorId: "user-b" }).where(eq(geoPromptRevisions.promptId, promptId)),
		);

		const [version] = await db
			.insert(geoDictionaryVersions)
			.values({ organizationId, version: 1, snapshot: { entities: [], products: [] }, createdBy: "user-a" })
			.returning();
		await rejected(db.delete(geoDictionaryVersions).where(eq(geoDictionaryVersions.id, version.id)));

		const [task] = await db
			.insert(geoOptimizationTasks)
			.values({ organizationId, title: "补充选型指南", kind: "FAQ", sourceKind: "MANUAL", createdBy: "user-a" })
			.returning();
		const [event] = await db
			.insert(geoTaskEvents)
			.values({ organizationId, taskId: task.id, toState: "PENDING_ANALYSIS", action: "create", actorId: "user-a" })
			.returning();
		await rejected(db.update(geoTaskEvents).set({ comment: "改写" }).where(eq(geoTaskEvents.id, event.id)));

		const rows = await db.select().from(geoAuditLogs).where(eq(geoAuditLogs.id, audit.id));
		expect(rows[0]?.action).toBe("test.write");
	});

	it("lets only a transaction that switched on the purge delete, and never update", async () => {
		const message = await rejected(
			db.transaction(async (tx) => {
				await tx.execute(sql`select set_config('geo.retention_purge', 'on', true)`);
				await tx.update(geoObservations).set({ responseText: "改写" }).where(eq(geoObservations.id, observationId));
			}),
		);
		expect(message).toMatch(/append-only|cannot/i);

		await db.transaction(async (tx) => {
			await tx.execute(sql`select set_config('geo.retention_purge', 'on', true)`);
			await tx.delete(geoObservations).where(eq(geoObservations.id, observationId));
		});
		// SET LOCAL ends with the transaction: the next statement is guarded again.
		const other = await insertObservation(organizationId, promptId, (await createTarget(organizationId)).id, NOW);
		await rejected(db.delete(geoObservations).where(eq(geoObservations.id, other.id)));
	});
});

describe("frozen prompt set items", () => {
	it("can be written while the set is a draft and frozen in the same transaction, then never again", async () => {
		const organizationId = await createOrganization();
		const prompt = await createPrompt(organizationId);
		const second = await createPrompt(organizationId);
		const [set] = await db
			.insert(geoPromptSets)
			.values({ organizationId, name: "基线", createdBy: "user-a" })
			.returning();

		await db.transaction(async (tx) => {
			await tx.select().from(geoPromptSets).where(eq(geoPromptSets.id, set.id)).for("update");
			await tx.delete(geoPromptSetItems).where(eq(geoPromptSetItems.setId, set.id));
			await tx.insert(geoPromptSetItems).values({
				organizationId,
				setId: set.id,
				promptId: prompt.id,
				promptRevision: 1,
				questionText: prompt.question,
			});
			await tx
				.update(geoPromptSets)
				.set({ status: "FROZEN", frozenAt: new Date(), frozenBy: "user-a" })
				.where(eq(geoPromptSets.id, set.id));
		});

		const item = and(eq(geoPromptSetItems.setId, set.id), eq(geoPromptSetItems.promptId, prompt.id));
		expect(await rejected(db.update(geoPromptSetItems).set({ questionText: "改写" }).where(item))).toMatch(
			/frozen prompt set/,
		);
		expect(await rejected(db.delete(geoPromptSetItems).where(item))).toMatch(/frozen prompt set/);
		expect(
			await rejected(
				db.insert(geoPromptSetItems).values({
					organizationId,
					setId: set.id,
					promptId: second.id,
					promptRevision: 1,
					questionText: second.question,
				}),
			),
		).toMatch(/frozen prompt set/);

		const items = await db.select().from(geoPromptSetItems).where(eq(geoPromptSetItems.setId, set.id));
		expect(items.map((row) => row.questionText)).toEqual([prompt.question]);
	});
});

describe("retention purge", () => {
	let organizationId: string;
	const deletedKeys: string[] = [];
	const ids: Record<string, string> = {};

	beforeAll(async () => {
		organizationId = await createOrganization();
		await db.insert(geoOrgSettings).values({
			organizationId,
			evidenceRetentionDays: 30,
			snapshotRetentionDays: 30,
			auditRetentionDays: 180,
		});
		const prompt = await createPrompt(organizationId);
		const target = await createTarget(organizationId);
		const evidenceKey = (name: string) => `geo/${organizationId}/evidence/${name}.json`;

		// An expired observation with everything that hangs off it.
		const expired = await insertObservation(organizationId, prompt.id, target.id, daysAgo(90), {
			evidenceUri: evidenceKey("expired"),
		});
		ids.expired = expired.id;
		await db.insert(geoObservationCitations).values({
			organizationId,
			observationId: expired.id,
			ordinal: 1,
			url: "https://www.example-electric.test/a",
		});
		const [first] = await db
			.insert(geoEvaluations)
			.values({
				organizationId,
				observationId: expired.id,
				version: 1,
				evaluatorVersion: "rules-1",
				brandMentioned: true,
				recommendation: "MENTIONED_ONLY",
				reviewStatus: "PENDING_REVIEW",
				isCurrent: false,
				createdBy: "system:evaluation",
			})
			.returning();
		const [second] = await db
			.insert(geoEvaluations)
			.values({
				organizationId,
				observationId: expired.id,
				version: 2,
				evaluatorVersion: "rules-1",
				brandMentioned: true,
				recommendation: "RECOMMENDED",
				reviewStatus: "CORRECTED",
				supersedesId: first.id,
				createdBy: "user-b",
			})
			.returning();
		await db.insert(geoObservationClaims).values({
			organizationId,
			observationId: expired.id,
			evaluationId: second.id,
			claimText: "额定电压 12kV",
		});
		const [task] = await db
			.insert(geoOptimizationTasks)
			.values({ organizationId, title: "纠正参数", kind: "FAQ", sourceKind: "OBSERVATION", createdBy: "user-a" })
			.returning();
		await db.insert(geoTaskEvidence).values({ organizationId, taskId: task.id, observationId: expired.id });

		// An expired observation that a kept retry still points at stays.
		const parent = await insertObservation(organizationId, prompt.id, target.id, daysAgo(80), {
			status: "TIMEOUT",
			responseText: null,
		});
		ids.parent = parent.id;
		const retry = await insertObservation(organizationId, prompt.id, target.id, daysAgo(5), {
			retryOfObservationId: parent.id,
			evidenceUri: evidenceKey("expired"),
		});
		ids.retry = retry.id;

		// Snapshots: one page with an old, superseded version and a QA-sampled one.
		const [source] = await db
			.insert(geoSiteSources)
			.values({
				organizationId,
				baseUrl: "https://www.example-electric.test/",
				allowedHosts: ["www.example-electric.test"],
				policyVersion: "1",
				createdBy: "user-a",
			})
			.returning();
		const [run] = await db
			.insert(geoSiteCrawlRuns)
			.values({
				organizationId,
				siteSourceId: source.id,
				mode: "FULL",
				policyVersion: "1",
				idempotencyKey: randomUUID(),
				requestedBy: "user-a",
			})
			.returning();
		const [page] = await db
			.insert(geoSitePages)
			.values({ organizationId, siteSourceId: source.id, normalizedUrl: "https://www.example-electric.test/p/1" })
			.returning();
		const [revertedPage] = await db
			.insert(geoSitePages)
			.values({ organizationId, siteSourceId: source.id, normalizedUrl: "https://www.example-electric.test/p/2" })
			.returning();
		const version = async (hash: string, days: number, pageId = page.id) => {
			const [row] = await db
				.insert(geoSitePageVersions)
				.values({
					organizationId,
					pageId,
					contentHash: hash,
					parserVersion: "p1",
					htmlObjectKey: `geo/${organizationId}/site/raw/${hash}.html`,
					parsedObjectKey: `geo/${organizationId}/site/parsed/${hash}.json`,
					fetchedAt: daysAgo(days),
					parseStatus: "PARSED",
				})
				.returning();
			await db.insert(geoSiteCrawlItems).values({
				organizationId,
				runId: run.id,
				url: `${page.normalizedUrl}?v=${hash}`,
				source: "SEED",
				status: "DONE",
				outcome: "NEW_VERSION",
				pageId,
				contentHash: hash,
				rawObjectKey: row.htmlObjectKey,
				fetchedAt: daysAgo(days),
				versionId: row.id,
			});
			return row;
		};
		ids.oldVersion = (await version("aaa", 120)).id;
		ids.sampledVersion = (await version("bbb", 100)).id;
		ids.citedVersion = (await version("ccc", 95)).id;
		ids.latestVersion = (await version("ddd", 90)).id;

		// A page whose content went A, B and back to A shows the older version again.
		const reverted = await version("eee", 110, revertedPage.id);
		ids.revertedVersion = reverted.id;
		ids.intermediateVersion = (await version("fff", 100, revertedPage.id)).id;
		await db.insert(geoSiteCrawlItems).values({
			organizationId,
			runId: run.id,
			url: `${revertedPage.normalizedUrl}?again`,
			source: "KNOWN",
			status: "DONE",
			outcome: "NEW_VERSION",
			pageId: revertedPage.id,
			contentHash: "eee",
			rawObjectKey: reverted.htmlObjectKey,
			fetchedAt: daysAgo(40),
			versionId: reverted.id,
		});

		const [sample] = await db
			.insert(geoSiteQaSamples)
			.values({ organizationId, siteSourceId: source.id, population: 4, sampleSize: 1, seed: "s", createdBy: "user-a" })
			.returning();
		await db
			.insert(geoSiteQaItems)
			.values({ organizationId, sampleId: sample.id, pageVersionId: ids.sampledVersion, fieldPath: "title" });
		const [assertion] = await db
			.insert(geoKnowledgeAssertions)
			.values({ organizationId, claimType: "SPEC", claimText: "额定电压 12kV" })
			.returning();
		await db.insert(geoAssertionSources).values({
			organizationId,
			assertionId: assertion.id,
			sourceKind: "PAGE_VERSION",
			pageVersionId: ids.citedVersion,
			extractedAt: daysAgo(95),
		});

		// Audit rows on both sides of the cutoff.
		const [oldAudit] = await db
			.insert(geoAuditLogs)
			.values({
				organizationId,
				actorId: "user-a",
				actorKind: "user",
				action: "brand.update",
				entityType: "brand",
				entityId: "x",
				createdAt: daysAgo(200),
			})
			.returning();
		ids.oldAudit = oldAudit.id;
		const [recentAudit] = await db
			.insert(geoAuditLogs)
			.values({
				organizationId,
				actorId: "user-a",
				actorKind: "user",
				action: "brand.update",
				entityType: "brand",
				entityId: "y",
				createdAt: daysAgo(10),
			})
			.returning();
		ids.recentAudit = recentAudit.id;
	});

	it("deletes what the organization's settings say has expired, and only that", async () => {
		const [config] = (await geoRetentionConfigs(db)).filter((row) => row.organizationId === organizationId);
		expect(config).toBeDefined();
		const result = await purgeExpiredGeoData(db, organizationId, config, {
			now: NOW,
			deleteObject: async (key) => {
				deletedKeys.push(key);
			},
			requestId: "retention-test",
		});

		expect(result.evidence.rows).toEqual({
			geo_observations: 1,
			geo_evaluations: 2,
			geo_observation_citations: 1,
			geo_observation_claims: 1,
			geo_task_evidence: 1,
		});
		const observations = await db
			.select({ id: geoObservations.id })
			.from(geoObservations)
			.where(eq(geoObservations.organizationId, organizationId));
		expect(observations.map((row) => row.id).sort()).toEqual([ids.parent, ids.retry].sort());
		// The kept retry still uses the expired observation's evidence file.
		expect(deletedKeys.filter((key) => key.includes("/evidence/"))).toEqual([]);

		expect(result.snapshot.rows).toEqual({ geo_site_page_versions: 1, geo_site_crawl_items: 1 });
		const versions = await db
			.select({ id: geoSitePageVersions.id })
			.from(geoSitePageVersions)
			.where(eq(geoSitePageVersions.organizationId, organizationId));
		expect(versions.map((row) => row.id).sort()).toEqual(
			[ids.sampledVersion, ids.citedVersion, ids.latestVersion, ids.revertedVersion, ids.intermediateVersion].sort(),
		);
		expect(deletedKeys.filter((key) => key.includes("/site/")).sort()).toEqual(
			[`geo/${organizationId}/site/parsed/aaa.json`, `geo/${organizationId}/site/raw/aaa.html`].sort(),
		);

		expect(result.audit.rows).toEqual({ geo_audit_logs: 1 });
		const audit = await db
			.select({ id: geoAuditLogs.id, action: geoAuditLogs.action, metadata: geoAuditLogs.metadata })
			.from(geoAuditLogs)
			.where(eq(geoAuditLogs.organizationId, organizationId));
		expect(audit.some((row) => row.id === ids.oldAudit)).toBe(false);
		expect(audit.some((row) => row.id === ids.recentAudit)).toBe(true);
		const summaries = audit.filter((row) => row.action === "retention.purge");
		expect(summaries.map((row) => (row.metadata as { category: string }).category).sort()).toEqual([
			"audit",
			"evidence",
			"snapshot",
		]);
	});

	it("finds nothing more on a second run and writes no further summaries", async () => {
		const [config] = (await geoRetentionConfigs(db)).filter((row) => row.organizationId === organizationId);
		const result = await purgeExpiredGeoData(db, organizationId, config, {
			now: NOW,
			deleteObject: async () => {
				throw new Error("nothing should be deleted");
			},
		});
		expect(result.evidence.rows).toEqual({});
		expect(result.snapshot.rows).toEqual({});
		expect(result.audit.rows).toEqual({ geo_audit_logs: 0 });
		const summaries = await db
			.select({ id: geoAuditLogs.id })
			.from(geoAuditLogs)
			.where(and(eq(geoAuditLogs.organizationId, organizationId), eq(geoAuditLogs.action, "retention.purge")));
		expect(summaries).toHaveLength(3);
	});
});

describe("retention and evidence objects", () => {
	let organizationId: string;
	let promptId: string;
	let targetId: string;
	let batchId: string;
	const deleted: string[] = [];
	const config = () => ({ evidenceRetentionDays: 30, snapshotRetentionDays: null, auditRetentionDays: null });
	const purge = () =>
		purgeExpiredGeoData(db, organizationId, config(), {
			now: NOW,
			deleteObject: async (key) => {
				deleted.push(key);
			},
		});
	const uploadKey = (name: string) => `geo/${organizationId}/evidence/${name.repeat(64)}.png`;

	async function recordUpload(name: string, extra: Partial<typeof geoEvidenceUploads.$inferInsert> = {}) {
		await db.insert(geoEvidenceUploads).values({
			organizationId,
			objectKey: uploadKey(name),
			sha256: name.repeat(64),
			contentType: "image/png",
			sizeBytes: 8,
			uploadedBy: "user-a",
			...extra,
		});
	}

	beforeAll(async () => {
		organizationId = await createOrganization();
		await db.insert(geoOrgSettings).values({ organizationId, evidenceRetentionDays: 30 });
		promptId = (await createPrompt(organizationId)).id;
		targetId = (await createTarget(organizationId)).id;
		const [set] = await db.insert(geoPromptSets).values({ organizationId, name: "基线", createdBy: "user-a" }).returning();
		const [batch] = await db
			.insert(geoSamplingBatches)
			.values({ organizationId, promptSetId: set.id, requestedBy: "user-a", idempotencyKey: randomUUID() })
			.returning();
		batchId = batch.id;
	});

	it("never deletes a knowledge original, report or snapshot an imported observation points at", async () => {
		const protectedKeys = [
			`geo/${organizationId}/knowledge/${"a".repeat(64)}.pdf`,
			`geo/${organizationId}/reports/r1/report.pdf`,
			`geo/${organizationId}/site/s1/raw/abc.html`,
			`geo/${organizationId}/observations/some-other-run/attempt-1.json`,
		];
		for (const evidenceUri of protectedKeys) {
			await insertObservation(organizationId, promptId, targetId, daysAgo(90), {
				surfaceMode: "MANUAL_EVIDENCE",
				importBatchId: randomUUID(),
				evidenceUri,
			});
		}
		const result = await purge();
		expect(result.evidence.rows.geo_observations).toBe(4);
		expect(deleted).toEqual([]);
	});

	it("does not delete an evidence-shaped key the observation's import never uploaded", async () => {
		await recordUpload("c", { importBatchId: randomUUID() });
		await insertObservation(organizationId, promptId, targetId, daysAgo(90), {
			surfaceMode: "MANUAL_EVIDENCE",
			importBatchId: randomUUID(),
			evidenceUri: uploadKey("c"),
		});
		await purge();
		expect(deleted).toEqual([]);
	});

	it("deletes the raw response of the observation's own run", async () => {
		const [run] = await db
			.insert(geoSamplingRuns)
			.values({
				organizationId,
				batchId,
				promptId,
				targetId,
				repeatIndex: 0,
				idempotencyKey: randomUUID(),
				status: "VALID",
			})
			.returning();
		const key = `geo/${organizationId}/observations/${run.id}/attempt-1.json`;
		await insertObservation(organizationId, promptId, targetId, daysAgo(90), { runId: run.id, evidenceUri: key });
		deleted.length = 0;
		await purge();
		expect(deleted).toEqual([key]);
	});

	it("deletes an imported file with its upload record once nothing uses it, and only then", async () => {
		const importBatchId = randomUUID();
		await recordUpload("d", { importBatchId });
		const shared = { surfaceMode: "MANUAL_EVIDENCE" as const, importBatchId, evidenceUri: uploadKey("d") };
		await insertObservation(organizationId, promptId, targetId, daysAgo(90), shared);
		const recent = await insertObservation(organizationId, promptId, targetId, daysAgo(5), shared);
		deleted.length = 0;
		await purge();
		expect(deleted).toEqual([]);

		await db.transaction(async (tx) => {
			await tx.execute(sql`select set_config('geo.retention_purge', 'on', true)`);
			await tx.delete(geoObservations).where(eq(geoObservations.id, recent.id));
		});
		await insertObservation(organizationId, promptId, targetId, daysAgo(90), shared);
		await purge();
		expect(deleted).toEqual([uploadKey("d")]);
		const records = await db
			.select()
			.from(geoEvidenceUploads)
			.where(eq(geoEvidenceUploads.objectKey, uploadKey("d")));
		expect(records).toEqual([]);
	});

	it("keeps a file someone just uploaded again, though the import that used it has expired", async () => {
		const importBatchId = randomUUID();
		await recordUpload("e", { importBatchId });
		await recordUpload("e", { createdAt: daysAgo(1) });
		await insertObservation(organizationId, promptId, targetId, daysAgo(90), {
			surfaceMode: "MANUAL_EVIDENCE",
			importBatchId,
			evidenceUri: uploadKey("e"),
		});
		deleted.length = 0;
		await purge();
		expect(deleted).toEqual([]);
	});

	it("removes an upload no import ever used once it is past retention", async () => {
		await recordUpload("f", { createdAt: daysAgo(90) });
		await recordUpload("0", { createdAt: daysAgo(5) });
		deleted.length = 0;
		const result = await purge();
		expect(deleted).toEqual([uploadKey("f")]);
		expect(result.evidence.rows.geo_evidence_uploads).toBe(1);
		const pending = await db.select().from(geoEvidenceUploads).where(eq(geoEvidenceUploads.objectKey, uploadKey("0")));
		expect(pending).toHaveLength(1);
	});

	it("leaves a note on the work order that loses the evidence", async () => {
		const observation = await insertObservation(organizationId, promptId, targetId, daysAgo(90));
		const [task] = await db
			.insert(geoOptimizationTasks)
			.values({ organizationId, title: "纠正参数", kind: "FAQ", sourceKind: "OBSERVATION", createdBy: "user-a" })
			.returning();
		await db.insert(geoTaskEvidence).values({ organizationId, taskId: task.id, observationId: observation.id });
		await purge();
		const events = await db.select().from(geoTaskEvents).where(eq(geoTaskEvents.taskId, task.id));
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ action: "EVIDENCE_EXPIRED", actorId: "system:retention" });
		expect(events[0]?.comment).toContain("1 条");
	});
});

describe("approval timeouts", () => {
	it("dates a task's review from when it entered that review, not from the epoch", async () => {
		const organizationId = await createOrganization();
		const [task] = await db
			.insert(geoOptimizationTasks)
			.values({
				organizationId,
				title: "补充选型指南",
				kind: "FAQ",
				state: "PENDING_TECH_REVIEW",
				sourceKind: "MANUAL",
				createdBy: "user-a",
			})
			.returning();
		const entered = new Date();
		await db.insert(geoTaskEvents).values({
			organizationId,
			taskId: task.id,
			fromState: "IN_PROGRESS",
			toState: "PENDING_TECH_REVIEW",
			action: "SUBMIT_FOR_REVIEW",
			actorId: "user-a",
			createdAt: entered,
		});

		expect((await findGeoApprovalTimeouts(db, organizationId, entered)).tasks).toEqual([]);
		const overdue = await findGeoApprovalTimeouts(db, organizationId, new Date(entered.getTime() + 73 * 3_600_000));
		expect(overdue.tasks).toEqual([expect.objectContaining({ id: task.id, enteredAt: entered })]);
	});
});
