import type { GeoPrincipal } from "@workspace/geo-domain";
import { db } from "@workspace/lib/db/db";
import { geoAuditLogs, geoPromptSetItems } from "@workspace/lib/db/schema";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { createBrand, listDictionaryVersions, updateBrand } from "@/server/geo/profile-core";
import {
	createNextPromptSetVersion,
	createPrompt,
	createPromptSet,
	freezePromptSet,
	getPromptSet,
	listBuyerRoles,
	transitionPrompt,
	updatePrompt,
	updatePromptSetItems,
} from "@/server/geo/prompts-core";
import { createGeoOrganization, expectGeoError } from "@/test/integration/geo-fixtures";

const paging = { limit: 50, offset: 0 };

describe("brand dictionary versions", () => {
	let admin: GeoPrincipal;

	beforeAll(async () => {
		const org = await createGeoOrganization();
		admin = await org.actor(["platform_admin"]);
	});

	it("records a new immutable version for every change and none for a no-op or a rejected change", async () => {
		const own = await createBrand(admin, {
			kind: "OWN",
			displayName: "示例电气",
			aliases: ["示例"],
			domains: ["www.example-electric.test"],
		});
		await createBrand(admin, { kind: "COMPETITOR", displayName: "样板开关", aliases: ["样板"] });
		await updateBrand(admin, own.id, { aliases: ["示例", "示例电器"] });
		await updateBrand(admin, own.id, { aliases: ["示例", "示例电器"] });
		await expectGeoError(
			createBrand(admin, { kind: "COMPETITOR", displayName: "另一家", aliases: ["示例"] }),
			"CONFLICT",
		);
		await updateBrand(admin, own.id, { status: "DISABLED" });

		const { rows, total } = await listDictionaryVersions(admin, paging);
		expect(total).toBe(4);
		expect(rows.map((row) => row.version)).toEqual([4, 3, 2, 1]);
		expect(rows[1]?.changes.map((change) => change.entityId)).toEqual([own.id]);
	});
});

describe("prompt review and frozen sets", () => {
	let author: GeoPrincipal;
	let reviewer: GeoPrincipal;
	let organizationId: string;

	const labels = async (principal: GeoPrincipal) => {
		const [role] = await listBuyerRoles(principal);
		return { buyerRoleId: role?.id, intent: "选型", productLine: "高低压开关柜", geoRegion: "华东" };
	};

	beforeAll(async () => {
		const org = await createGeoOrganization();
		organizationId = org.organizationId;
		author = await org.actor(["geo_operator", "marketing_reviewer"], "运营");
		reviewer = await org.actor(["marketing_reviewer"], "市场审核");
	});

	it("walks a prompt from draft to baseline, refusing self-review and an incomplete submission", async () => {
		const bare = await createPrompt(author, { question: "开关柜厂家怎么选？" });
		await expectGeoError(transitionPrompt(author, bare.id, { action: "SUBMIT" }), "VALIDATION_ERROR");

		const prompt = await createPrompt(author, { question: "高低压开关柜哪家质量好？", ...(await labels(author)) });
		await expectGeoError(createPrompt(author, { question: " 高低压开关柜哪家质量好? " }), "CONFLICT");
		await transitionPrompt(author, prompt.id, { action: "SUBMIT" });
		await expectGeoError(transitionPrompt(author, prompt.id, { action: "APPROVE" }), "FORBIDDEN");
		await expectGeoError(transitionPrompt(reviewer, prompt.id, { action: "REJECT" }), "VALIDATION_ERROR");
		const approved = await transitionPrompt(reviewer, prompt.id, { action: "APPROVE", comment: "可以" });
		expect(approved).toMatchObject({ status: "BASELINE", reviewerId: reviewer.actorId });

		const audit = await db
			.select({ action: geoAuditLogs.action })
			.from(geoAuditLogs)
			.where(and(eq(geoAuditLogs.organizationId, organizationId), eq(geoAuditLogs.entityId, prompt.id)));
		expect(audit.map((row) => row.action).sort()).toEqual(["prompt.approve", "prompt.create", "prompt.submit"]);
	});

	it("freezes a set to the revisions it holds and keeps them when the prompt is revised", async () => {
		const prompt = await createPrompt(author, { question: "10kV 环网柜推荐品牌", ...(await labels(author)) });
		const draft = await createPrompt(author, { question: "开关柜售后哪家好", ...(await labels(author)) });
		await transitionPrompt(author, prompt.id, { action: "SUBMIT" });
		await transitionPrompt(reviewer, prompt.id, { action: "APPROVE" });

		const set = await createPromptSet(author, { name: "季度基线", promptIds: [prompt.id, draft.id] });
		await expectGeoError(freezePromptSet(author, set.id), "VALIDATION_ERROR");
		await expectGeoError(freezePromptSet(reviewer, set.id), "FORBIDDEN");
		await updatePromptSetItems(author, set.id, { promptIds: [prompt.id] });

		const frozen = await freezePromptSet(author, set.id);
		expect(frozen.items).toEqual([
			expect.objectContaining({ promptId: prompt.id, promptRevision: 1, questionText: "10kV 环网柜推荐品牌" }),
		]);
		await expectGeoError(freezePromptSet(author, set.id), "CONFLICT");
		await expectGeoError(updatePromptSetItems(author, set.id, { promptIds: [prompt.id, draft.id] }), "CONFLICT");

		await transitionPrompt(author, prompt.id, { action: "REVISE" });
		const revised = await updatePrompt(author, prompt.id, { question: "10kV 环网柜哪个品牌可靠" });
		expect(revised.currentRevision).toBe(2);

		const items = await db.select().from(geoPromptSetItems).where(eq(geoPromptSetItems.setId, set.id));
		expect(items.map((item) => [item.promptRevision, item.questionText])).toEqual([[1, "10kV 环网柜推荐品牌"]]);

		const next = await createNextPromptSetVersion(author, set.id);
		expect(next).toMatchObject({ version: 2, status: "DRAFT", parentSetId: set.id });
		await expectGeoError(createPromptSet(author, { name: "季度基线" }), "CONFLICT");
		// The revised prompt is a draft again, so the next version cannot freeze until it is reviewed.
		await expectGeoError(freezePromptSet(author, next.id), "VALIDATION_ERROR");
		await transitionPrompt(author, prompt.id, { action: "SUBMIT" });
		await transitionPrompt(reviewer, prompt.id, { action: "APPROVE" });
		const refrozen = await freezePromptSet(author, next.id);
		expect(refrozen.items.map((item) => [item.promptRevision, item.questionText])).toEqual([
			[2, "10kV 环网柜哪个品牌可靠"],
		]);
		expect((await getPromptSet(author, set.id)).items[0]?.questionText).toBe("10kV 环网柜推荐品牌");
	});
});
