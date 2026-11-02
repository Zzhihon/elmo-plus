import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { GeoPrincipal } from "@workspace/geo-domain";
import { db } from "@workspace/lib/db/db";
import {
	geoAssertionConflicts,
	geoAssertionSources,
	geoContentReviews,
	geoContentVersions,
	geoKnowledgeAssertions,
	geoPublicationRecords,
	geoSitePages,
	geoSitePageVersions,
	geoSiteSources,
} from "@workspace/lib/db/schema";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDraft, recordPublication, reviseDraft, transitionDraft } from "@/server/geo/drafts-core";
import {
	attachAssetSource,
	registerAssetClaim,
	reviewKnowledgeAsset,
	uploadKnowledgeAsset,
} from "@/server/geo/knowledge-assets-core";
import { listConflicts, resolveConflict, reviewClaim } from "@/server/geo/knowledge-core";
import { createGeoOrganization, expectGeoError } from "@/test/integration/geo-fixtures";

let objectRoot: string;
let organizationId: string;
let operator: GeoPrincipal;
let tech: GeoPrincipal;
let secondTech: GeoPrincipal;
let marketing: GeoPrincipal;
let knowledgeReviewer: GeoPrincipal;
let assetId: string;
let entityId: string;
let approvedFactId: string;

const approve = {
	decision: "APPROVE" as const,
	basis: "与客户提供的产品样本第 3 页一致",
	publicationScope: "PUBLIC" as const,
};

beforeAll(async () => {
	objectRoot = await mkdtemp(path.join(tmpdir(), "geo-knowledge-objects-"));
	process.env.GEO_OBJECT_STORE_URL = `file://${objectRoot}`;
	const org = await createGeoOrganization();
	organizationId = org.organizationId;
	operator = await org.actor(["geo_operator"]);
	tech = await org.actor(["tech_reviewer"]);
	secondTech = await org.actor(["tech_reviewer"]);
	marketing = await org.actor(["marketing_reviewer"]);
	knowledgeReviewer = await org.actor(["knowledge_reviewer"]);

	const pdf = new File([new TextEncoder().encode(`%PDF-1.4\n% 示例电气产品样本 ${randomUUID()}\n%%EOF`)], "样本.pdf", {
		type: "application/pdf",
	});
	const { asset } = await uploadKnowledgeAsset(operator, pdf, {
		title: "KYN28 产品样本",
		assetType: "PRODUCT_SPEC",
		confidentiality: "PUBLIC",
		publicationScope: "PUBLIC",
	});
	assetId = asset.id;
	await expectGeoError(reviewKnowledgeAsset(operator, assetId, { decision: "APPROVE", note: "本人上传" }), "FORBIDDEN");
	await reviewKnowledgeAsset(knowledgeReviewer, assetId, { decision: "APPROVE", note: "原件核对无误" });
});

afterAll(async () => {
	await rm(objectRoot, { recursive: true, force: true });
});

describe("knowledge review gates", () => {
	it("keeps a high-risk fact from its own author and from a reviewer without technical standing", async () => {
		const registered = await registerAssetClaim(tech, assetId, {
			entity: { kind: "PRODUCT", title: "KYN28 高压开关柜" },
			claimType: "TECH_PARAMETER",
			fieldPath: "ratedVoltage",
			claimText: "KYN28 高压开关柜额定电压 12kV",
			value: "12kV",
			locator: { page: 3 },
		});
		entityId = registered.entityId;
		approvedFactId = registered.assertionId;

		await expectGeoError(reviewClaim(tech, approvedFactId, approve), "FORBIDDEN");
		await expectGeoError(reviewClaim(knowledgeReviewer, approvedFactId, approve), "FORBIDDEN");
		const result = await reviewClaim(secondTech, approvedFactId, approve);
		expect(result.status).toBe("APPROVED");
	});

	it("needs a customer original before a website-only high-risk value can be approved", async () => {
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
		const [page] = await db
			.insert(geoSitePages)
			.values({ organizationId, siteSourceId: source.id, normalizedUrl: "https://www.example-electric.test/p/kyn28" })
			.returning();
		const [version] = await db
			.insert(geoSitePageVersions)
			.values({
				organizationId,
				pageId: page.id,
				contentHash: "h1",
				parserVersion: "p1",
				htmlObjectKey: `geo/${organizationId}/site/raw/h1.html`,
				fetchedAt: new Date(),
				parseStatus: "PARSED",
			})
			.returning();
		// As the crawl writes it: a candidate with the page version as its only source.
		const [assertion] = await db
			.insert(geoKnowledgeAssertions)
			.values({
				organizationId,
				entityId,
				claimType: "TECH_PARAMETER",
				fieldPath: "ratedCurrent",
				claimText: "KYN28 高压开关柜额定电流 1250A",
				normalizedValue: "1250a",
				riskLevel: "HIGH",
				status: "PENDING_REVIEW",
				publicationScope: "PUBLIC",
			})
			.returning();
		await db.insert(geoAssertionSources).values({
			organizationId,
			assertionId: assertion.id,
			sourceKind: "PAGE_VERSION",
			pageVersionId: version.id,
			extractedAt: new Date(),
		});

		await expectGeoError(reviewClaim(tech, assertion.id, approve), "EVIDENCE_REQUIRED");
		await attachAssetSource(operator, assertion.id, { assetId, locator: { page: 4 } });
		expect((await reviewClaim(tech, assertion.id, approve)).status).toBe("APPROVED");
	});

	it("opens a conflict for a different value and settles it only by a reviewer's decision", async () => {
		const other = await registerAssetClaim(operator, assetId, {
			entity: { id: entityId },
			claimType: "TECH_PARAMETER",
			fieldPath: "ratedVoltage",
			claimText: "KYN28 高压开关柜额定电压 24kV",
			value: "24kV",
			locator: { page: 7 },
		});
		expect(other.conflicts).toBe(1);
		await expectGeoError(reviewClaim(tech, other.assertionId, approve), "CONFLICT");

		const { rows } = await listConflicts(tech, {}, { limit: 10, offset: 0 });
		expect(rows).toEqual([expect.objectContaining({ candidate: expect.objectContaining({ id: other.assertionId }) })]);
		await resolveConflict(tech, rows[0].id, { resolution: "KEEP_APPROVED", basis: "样本第 7 页为另一型号" });

		const [conflict] = await db.select().from(geoAssertionConflicts).where(eq(geoAssertionConflicts.id, rows[0].id));
		expect(conflict?.status).toBe("RESOLVED");
		const [candidate] = await db
			.select()
			.from(geoKnowledgeAssertions)
			.where(eq(geoKnowledgeAssertions.id, other.assertionId));
		const [kept] = await db.select().from(geoKnowledgeAssertions).where(eq(geoKnowledgeAssertions.id, approvedFactId));
		expect([candidate?.status, kept?.status]).toEqual(["REJECTED", "APPROVED"]);
	});
});

describe("content drafts", () => {
	it("refuses model generation until the organization approves model use, so the draft is written by hand", async () => {
		await expectGeoError(
			createDraft(operator, { kind: "FAQ", title: "KYN28 选型问答", assertionIds: [approvedFactId], mode: "LLM" }),
			"FORBIDDEN",
		);
	});

	it("checks facts on submit, takes technical then marketing review, and goes back to draft on rejection", async () => {
		const draft = await createDraft(operator, {
			kind: "FAQ",
			title: "KYN28 选型问答",
			assertionIds: [approvedFactId],
			mode: "MANUAL",
			body: "KYN28 高压开关柜的额定电压为 40.5kV[F1]。",
		});
		expect(draft.validation.blocking).toBe(true);
		await expectGeoError(transitionDraft(operator, draft.id, { action: "SUBMIT" }), "EVIDENCE_REQUIRED");

		await reviseDraft(operator, draft.id, { mode: "MANUAL", body: "KYN28 高压开关柜的额定电压为 12kV[F1]。" });
		await transitionDraft(operator, draft.id, { action: "SUBMIT" });
		await expectGeoError(transitionDraft(marketing, draft.id, { action: "APPROVE_MARKETING" }), "CONFLICT");
		await transitionDraft(tech, draft.id, { action: "APPROVE_TECH" });
		await expectGeoError(transitionDraft(marketing, draft.id, { action: "REJECT" }), "VALIDATION_ERROR");
		expect(await transitionDraft(marketing, draft.id, { action: "REJECT", comment: "请补充适用场景" })).toMatchObject({
			state: "REJECTED",
		});

		await reviseDraft(operator, draft.id, {
			mode: "MANUAL",
			body: "KYN28 高压开关柜的额定电压为 12kV[F1]，适用于配电室。",
			note: "补充适用场景",
		});
		await transitionDraft(operator, draft.id, { action: "SUBMIT" });
		await transitionDraft(tech, draft.id, { action: "APPROVE_TECH" });
		expect(await transitionDraft(marketing, draft.id, { action: "APPROVE_MARKETING" })).toMatchObject({
			state: "APPROVED",
		});
		await expectGeoError(
			recordPublication(marketing, draft.id, {
				url: "https://www.example-electric.test/faq/kyn28",
				publishedAt: new Date().toISOString(),
				proofNote: "官网后台截图",
			}),
			"FORBIDDEN",
		);
		expect(
			await recordPublication(operator, draft.id, {
				url: "https://www.example-electric.test/faq/kyn28",
				publishedAt: new Date().toISOString(),
				proofNote: "官网后台截图",
			}),
		).toMatchObject({ state: "PUBLISHED" });

		const versions = await db.select().from(geoContentVersions).where(eq(geoContentVersions.itemId, draft.id));
		expect(versions.map((row) => row.version).sort()).toEqual([1, 2, 3]);
		const reviews = await db.select().from(geoContentReviews).where(eq(geoContentReviews.itemId, draft.id));
		expect(reviews.map((row) => row.action).sort()).toEqual(
			[
				"REVISE",
				"SUBMIT",
				"APPROVE_TECH",
				"REJECT",
				"REVISE",
				"SUBMIT",
				"APPROVE_TECH",
				"APPROVE_MARKETING",
				"PUBLISH",
			].sort(),
		);
		const publications = await db
			.select()
			.from(geoPublicationRecords)
			.where(eq(geoPublicationRecords.itemId, draft.id));
		expect(publications).toEqual([expect.objectContaining({ version: 3 })]);
	});
});
