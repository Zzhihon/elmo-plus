import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { GeoPrincipal, GeoScanStatus } from "@workspace/geo-domain";
import { db } from "@workspace/lib/db/db";
import { geoKnowledgeAssertions, geoKnowledgeAssets } from "@workspace/lib/db/schema";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDraft, exportDraft, linkDraftTask, recordPublication, transitionDraft } from "@/server/geo/drafts-core";
import {
	attachAssetSource,
	downloadKnowledgeAsset,
	getKnowledgeAsset,
	registerAssetClaim,
	reviewKnowledgeAsset,
	updateKnowledgeAsset,
	uploadKnowledgeAsset,
} from "@/server/geo/knowledge-assets-core";
import { getClaimDetail, listConflicts, resolveConflict, reviewClaim, searchClaims } from "@/server/geo/knowledge-core";
import { createTask, getTaskDetail, transitionTask, updateTask } from "@/server/geo/tasks-core";
import { createGeoOrganization, expectGeoError } from "@/test/integration/geo-fixtures";

let objectRoot: string;
let operator: GeoPrincipal;
let tech: GeoPrincipal;
let secondTech: GeoPrincipal;
let marketing: GeoPrincipal;
let knowledgeReviewer: GeoPrincipal;
let viewer: GeoPrincipal;

const SECRET_QUOTE = "机密合同第七条载明的报价原文";
const SECRET_CLAIM = "内部成本口径 880万元";

const approve = { decision: "APPROVE" as const, basis: "与原件核对一致", publicationScope: "PUBLIC" as const };

beforeAll(async () => {
	objectRoot = await mkdtemp(path.join(tmpdir(), "geo-knowledge-gates-"));
	vi.stubEnv("GEO_OBJECT_STORE_URL", `file://${objectRoot}`);
	const org = await createGeoOrganization();
	operator = await org.actor(["geo_operator"]);
	tech = await org.actor(["tech_reviewer"]);
	secondTech = await org.actor(["tech_reviewer"]);
	marketing = await org.actor(["marketing_reviewer"]);
	knowledgeReviewer = await org.actor(["knowledge_reviewer"]);
	viewer = await org.actor(["viewer"]);
});

afterAll(async () => {
	await rm(objectRoot, { recursive: true, force: true });
});

function pdf(): File {
	return new File([new TextEncoder().encode(`%PDF-1.4\n% ${randomUUID()}\n%%EOF`)], "原件.pdf", {
		type: "application/pdf",
	});
}

async function upload(
	input: { confidentiality?: "PUBLIC" | "INTERNAL" | "CONFIDENTIAL"; scan?: GeoScanStatus; approved?: boolean } = {},
): Promise<string> {
	const confidentiality = input.confidentiality ?? "PUBLIC";
	const { asset } = await uploadKnowledgeAsset(operator, pdf(), {
		title: "示例电气资料",
		assetType: "PRODUCT_SPEC",
		confidentiality,
		publicationScope: confidentiality,
		validUntil: "2099-01-01",
	});
	await db
		.update(geoKnowledgeAssets)
		.set({ scanStatus: input.scan ?? "CLEAN" })
		.where(eq(geoKnowledgeAssets.id, asset.id));
	if (input.approved !== false) {
		await reviewKnowledgeAsset(knowledgeReviewer, asset.id, { decision: "APPROVE", note: "原件核对无误" });
	}
	return asset.id;
}

function fieldClaim(field: string, value: string, entityTitle = `样板开关-${field}`) {
	return {
		entity: { kind: "PRODUCT" as const, title: entityTitle },
		claimType: "TECH_PARAMETER" as const,
		fieldPath: field,
		claimText: `样板开关额定值 ${value}`,
		value,
		locator: { page: 2 },
	};
}

async function approvedPublicFact(field: string, value: string) {
	const assetId = await upload();
	const { assertionId } = await registerAssetClaim(operator, assetId, fieldClaim(field, value));
	await reviewClaim(tech, assertionId, approve);
	return { assetId, assertionId };
}

async function approvedDraft(assertionIds: string[], body: string) {
	const { id } = await createDraft(operator, { kind: "FAQ", title: "选型问答", assertionIds, mode: "MANUAL", body });
	await transitionDraft(operator, id, { action: "SUBMIT" });
	await transitionDraft(tech, id, { action: "APPROVE_TECH" });
	await transitionDraft(marketing, id, { action: "APPROVE_MARKETING" });
	return id;
}

async function taskInReview(input: { owner: GeoPrincipal; riskLevel?: "NORMAL" | "HIGH"; assertionIds?: string[] }) {
	const { task } = await createTask(operator, {
		title: "补充选型内容",
		kind: "FAQ",
		sourceKind: "MANUAL",
		riskLevel: input.riskLevel,
		ownerId: input.owner.actorId,
		evidence: input.assertionIds ? { assertionIds: input.assertionIds } : undefined,
	});
	await transitionTask(operator, task.id, { action: "TRIAGE" });
	await transitionTask(operator, task.id, { action: "ASSIGN", ownerId: input.owner.actorId });
	await transitionTask(operator, task.id, { action: "SUBMIT_FOR_REVIEW" });
	return task.id;
}

const publication = () => ({
	url: "https://www.example-electric.test/faq",
	publishedAt: new Date().toISOString(),
	proofNote: "官网后台截图",
});

describe("facts behind a release", () => {
	it("refuses to submit a high-risk value that cites nothing", async () => {
		const { assertionId } = await approvedPublicFact("uncited", "12kV");
		const { id, validation } = await createDraft(operator, {
			kind: "FAQ",
			title: "选型问答",
			assertionIds: [assertionId],
			mode: "MANUAL",
			body: "样板开关的额定电压为 12kV。",
		});
		expect(validation.blocking).toBe(true);
		await expectGeoError(transitionDraft(operator, id, { action: "SUBMIT" }), "EVIDENCE_REQUIRED");
	});

	it("stops export and publication when a fact the version was written from lapses, cited or not", async () => {
		const cited = await approvedPublicFact("cited", "12kV");
		const unused = await approvedPublicFact("unused", "630A");
		const id = await approvedDraft([cited.assertionId, unused.assertionId], "样板开关的额定电压为 12kV[F1]。");
		const response = await exportDraft(operator, id, "md");
		expect(response.status).toBe(200);

		await reviewClaim(secondTech, unused.assertionId, { decision: "INVALIDATE", basis: "原件已作废" });
		await expectGeoError(exportDraft(operator, id, "md"), "EVIDENCE_REQUIRED");
		await expectGeoError(recordPublication(operator, id, publication()), "EVIDENCE_REQUIRED");
	});
});

describe("what a reader without clearance gets", () => {
	let confidentialAsset: string;
	let confidentialClaim: string;
	let publicClaimWithSecretSource: string;

	beforeAll(async () => {
		confidentialAsset = await upload({ confidentiality: "CONFIDENTIAL" });
		const registered = await registerAssetClaim(tech, confidentialAsset, {
			entity: { kind: "COMPANY", title: "示例电气机密" },
			claimType: "OTHER",
			fieldPath: "cost",
			claimText: SECRET_CLAIM,
			value: SECRET_CLAIM,
			locator: { page: 7, quote: SECRET_QUOTE },
		});
		confidentialClaim = registered.assertionId;

		const openAsset = await upload();
		const open = await registerAssetClaim(operator, openAsset, fieldClaim("mixed", "12kV"));
		publicClaimWithSecretSource = open.assertionId;
		await attachAssetSource(tech, publicClaimWithSecretSource, {
			assetId: confidentialAsset,
			locator: { page: 7, quote: SECRET_QUOTE },
		});
		await reviewClaim(tech, publicClaimWithSecretSource, approve);
	});

	it("keeps a confidential original's words and identity out of the review history", async () => {
		const detail = await getClaimDetail(viewer, publicClaimWithSecretSource);
		expect(JSON.stringify(detail)).not.toContain(SECRET_QUOTE);
		expect(JSON.stringify(detail)).not.toContain(confidentialAsset);
		expect(detail.reviews[0].sourceRef.some((source) => source.hidden)).toBe(true);
	});

	it("does not store a document's quote in the review snapshot at all", async () => {
		const detail = await getClaimDetail(tech, publicClaimWithSecretSource);
		expect(JSON.stringify(detail.reviews)).not.toContain(SECRET_QUOTE);
		expect(detail.reviews[0].sourceRef.some((source) => source.assetId === confidentialAsset)).toBe(true);
	});

	it("blanks a confidential claim on the asset it came from", async () => {
		const openAsset = await upload({ confidentiality: "INTERNAL" });
		const { assertionId } = await registerAssetClaim(operator, openAsset, {
			entity: { kind: "COMPANY", title: "示例电气内部" },
			claimType: "OTHER",
			fieldPath: "margin",
			claimText: SECRET_CLAIM,
			value: SECRET_CLAIM,
			locator: { page: 1, quote: SECRET_QUOTE },
		});
		await db
			.update(geoKnowledgeAssertions)
			.set({ publicationScope: "CONFIDENTIAL" })
			.where(eq(geoKnowledgeAssertions.id, assertionId));

		const seen = await getKnowledgeAsset(viewer, openAsset);
		expect(JSON.stringify(seen)).not.toContain(SECRET_CLAIM);
		expect(JSON.stringify(seen)).not.toContain(SECRET_QUOTE);
		expect(seen.claims[0]).toMatchObject({ id: assertionId, claimText: null });
		const cleared = await getKnowledgeAsset(tech, openAsset);
		expect(cleared.claims[0].claimText).toBe(SECRET_CLAIM);
	});

	it("blanks a confidential claim on a task's evidence", async () => {
		const { task } = await createTask(tech, {
			title: "核对保密事实",
			kind: "FACT_CORRECTION",
			sourceKind: "ASSERTION",
			sourceRef: `assertion:${confidentialClaim}`,
			evidence: { assertionIds: [confidentialClaim] },
		});
		const seen = await getTaskDetail(viewer, task.id);
		expect(JSON.stringify(seen)).not.toContain(SECRET_CLAIM);
		expect(seen.evidence[0].assertionClaim).toBeNull();
		expect((await getTaskDetail(tech, task.id)).evidence[0].assertionClaim).toBe(SECRET_CLAIM);
	});

	it("hides it from search and direct reads", async () => {
		const { rows } = await searchClaims(viewer, { q: "成本口径" }, { limit: 20, offset: 0 });
		expect(rows).toEqual([]);
		await expectGeoError(getClaimDetail(viewer, confidentialClaim), "NOT_FOUND");
	});

	it("does not reveal or add to a confidential twin when someone without clearance registers the same value", async () => {
		const assetId = await upload();
		const twin = await registerAssetClaim(operator, assetId, {
			entity: { kind: "COMPANY", title: "示例电气机密" },
			claimType: "OTHER",
			fieldPath: "cost",
			claimText: SECRET_CLAIM,
			value: SECRET_CLAIM,
			locator: { page: 1 },
		});
		expect(twin.created).toBe(true);
		expect(twin.assertionId).not.toBe(confidentialClaim);
	});
});

describe("one approved value per field", () => {
	it("sends a value rejected in favour of the approved one back to a conflict when resubmitted", async () => {
		const { assetId, assertionId: keptId } = await approvedPublicFact("resubmit", "12kV");
		const { assertionId: candidateId } = await registerAssetClaim(operator, assetId, fieldClaim("resubmit", "24kV"));
		const { rows } = await listConflicts(tech, { status: "OPEN" }, { limit: 50, offset: 0 });
		const conflict = rows.find((row) => row.candidate.id === candidateId);
		if (!conflict) throw new Error("conflict was not opened");
		await resolveConflict(secondTech, conflict.id, { resolution: "KEEP_APPROVED", basis: "原件仍是 12kV" });

		await reviewClaim(operator, candidateId, { decision: "RESUBMIT", basis: "再次提交" });
		await expectGeoError(reviewClaim(secondTech, candidateId, approve), "CONFLICT");
		const [kept] = await db.select().from(geoKnowledgeAssertions).where(eq(geoKnowledgeAssertions.id, keptId));
		expect(kept.status).toBe("APPROVED");
	});

	it("approves only one of two different values reviewed at the same moment", async () => {
		const assetId = await upload();
		const first = await registerAssetClaim(operator, assetId, fieldClaim("race", "12kV"));
		const second = await registerAssetClaim(operator, assetId, fieldClaim("race", "24kV"));
		const outcomes = await Promise.allSettled([
			reviewClaim(tech, first.assertionId, approve),
			reviewClaim(secondTech, second.assertionId, approve),
		]);
		expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
		const approved = await db
			.select({ id: geoKnowledgeAssertions.id })
			.from(geoKnowledgeAssertions)
			.where(
				and(
					eq(geoKnowledgeAssertions.entityId, first.entityId),
					eq(geoKnowledgeAssertions.fieldPath, "race"),
					eq(geoKnowledgeAssertions.status, "APPROVED"),
				),
			);
		expect(approved).toHaveLength(1);
	});

	it("does not count a conflict with a confidential value for someone who may not see it", async () => {
		const secret = await upload({ confidentiality: "CONFIDENTIAL" });
		const entity = { kind: "COMPANY" as const, title: "示例电气保密字段" };
		const base = { entity, claimType: "OTHER" as const, fieldPath: "secret-value", locator: { page: 1 } };
		const held = await registerAssetClaim(tech, secret, { ...base, claimText: "值甲", value: "值甲" });
		await reviewClaim(secondTech, held.assertionId, {
			decision: "APPROVE",
			basis: "原件一致",
			publicationScope: "CONFIDENTIAL",
		});
		const open = await upload();
		const other = await registerAssetClaim(operator, open, { ...base, claimText: "值乙", value: "值乙" });
		expect(other.conflicts).toBe(0);
	});

	it("can settle a conflict whose candidate is still waiting for evidence", async () => {
		const { assetId } = await approvedPublicFact("needs-evidence", "12kV");
		const { assertionId } = await registerAssetClaim(operator, assetId, fieldClaim("needs-evidence", "24kV"));
		await reviewClaim(secondTech, assertionId, { decision: "REQUEST_EVIDENCE", basis: "请补充原件" });
		const { rows } = await listConflicts(tech, { status: "OPEN" }, { limit: 50, offset: 0 });
		const conflict = rows.find((row) => row.candidate.id === assertionId);
		if (!conflict) throw new Error("conflict was not opened");
		await resolveConflict(secondTech, conflict.id, { resolution: "KEEP_APPROVED", basis: "保留原值" });
		const [row] = await db.select().from(geoKnowledgeAssertions).where(eq(geoKnowledgeAssertions.id, assertionId));
		expect(row.status).toBe("REJECTED");
	});
});

describe("customer originals", () => {
	it("cannot stand behind a high-risk fact until the file has been scanned clean", async () => {
		const assetId = await upload({ scan: "UNSCANNED" });
		const { assertionId } = await registerAssetClaim(operator, assetId, fieldClaim("unscanned", "12kV"));
		await expectGeoError(reviewClaim(tech, assertionId, approve), "EVIDENCE_REQUIRED");

		await db.update(geoKnowledgeAssets).set({ scanStatus: "CLEAN" }).where(eq(geoKnowledgeAssets.id, assetId));
		expect((await reviewClaim(tech, assertionId, approve)).status).toBe("APPROVED");
	});

	it("is only handed out unscanned to someone who has to review it", async () => {
		const assetId = await upload({ scan: "UNSCANNED" });
		await expectGeoError(downloadKnowledgeAsset(viewer, assetId), "CONFLICT");
		expect((await downloadKnowledgeAsset(knowledgeReviewer, assetId)).status).toBe(200);
	});

	it("goes back to pending review when its expiry is moved later, and not by the person who moved it", async () => {
		const assetId = await upload();
		const later = await updateKnowledgeAsset(tech, assetId, { validUntil: "2100-01-01" });
		expect(later.approvalStatus).toBe("PENDING");
		await expectGeoError(reviewKnowledgeAsset(tech, assetId, { decision: "APPROVE", note: "续期" }), "FORBIDDEN");
		await reviewKnowledgeAsset(knowledgeReviewer, assetId, { decision: "APPROVE", note: "看过新证书" });

		const sooner = await updateKnowledgeAsset(operator, assetId, { validUntil: "2098-01-01" });
		expect(sooner.approvalStatus).toBe("APPROVED");
	});

	it("takes a lapsed-and-extended original away from the high-risk facts it supported", async () => {
		const { assetId, assertionId } = await approvedPublicFact("extended", "12kV");
		await updateKnowledgeAsset(operator, assetId, { validUntil: "2100-01-01" });
		const [row] = await db.select().from(geoKnowledgeAssertions).where(eq(geoKnowledgeAssertions.id, assertionId));
		expect(row.status).toBe("SOURCE_UNAVAILABLE");
	});
});

describe("separation of duties on a task", () => {
	it("takes the risk from the task's evidence, whatever the creator declared", async () => {
		const { assertionId } = await approvedPublicFact("task-evidence", "12kV");
		const id = await taskInReview({ owner: tech, riskLevel: "NORMAL", assertionIds: [assertionId] });
		await expectGeoError(transitionTask(tech, id, { action: "APPROVE_TECH" }), "FORBIDDEN");
		expect((await transitionTask(secondTech, id, { action: "APPROVE_TECH" })).riskLevel).toBe("HIGH");
	});

	it("takes the risk from content linked after the task was opened", async () => {
		const { assertionId } = await approvedPublicFact("task-content", "12kV");
		const id = await taskInReview({ owner: tech, riskLevel: "NORMAL" });
		await createDraft(operator, {
			kind: "FAQ",
			title: "选型问答",
			taskId: id,
			assertionIds: [assertionId],
			mode: "MANUAL",
			body: "样板开关的额定电压为 12kV[F1]。",
		});
		await expectGeoError(transitionTask(tech, id, { action: "APPROVE_TECH" }), "FORBIDDEN");
	});

	it("keeps a former owner from reviewing the task after handing it over", async () => {
		const id = await taskInReview({ owner: tech, riskLevel: "HIGH" });
		await transitionTask(operator, id, { action: "PAUSE", comment: "更换责任人" });
		await updateTask(operator, id, { ownerId: secondTech.actorId });
		await transitionTask(operator, id, { action: "RESUME" });
		await expectGeoError(transitionTask(tech, id, { action: "APPROVE_TECH" }), "FORBIDDEN");
	});

	it("re-checks linked content when the task is published", async () => {
		const { assertionId } = await approvedPublicFact("task-publish", "12kV");
		const draftId = await approvedDraft([assertionId], "样板开关的额定电压为 12kV[F1]。");
		const { task } = await createTask(operator, { title: "发布选型内容", kind: "FAQ", sourceKind: "MANUAL" });
		await linkDraftTask(operator, draftId, task.id);
		await transitionTask(operator, task.id, { action: "TRIAGE" });
		await transitionTask(operator, task.id, { action: "ASSIGN", ownerId: knowledgeReviewer.actorId });
		await transitionTask(operator, task.id, { action: "SUBMIT_FOR_REVIEW" });
		await transitionTask(secondTech, task.id, { action: "APPROVE_TECH" });
		await transitionTask(marketing, task.id, { action: "APPROVE_MARKETING" });

		await reviewClaim(secondTech, assertionId, { decision: "INVALIDATE", basis: "原件已作废" });
		await expectGeoError(
			transitionTask(operator, task.id, {
				action: "PUBLISH",
				publishedUrl: "https://www.example-electric.test/faq",
				publishedAt: new Date().toISOString(),
				proofNote: "官网后台截图",
			}),
			"EVIDENCE_REQUIRED",
		);
	});
});
