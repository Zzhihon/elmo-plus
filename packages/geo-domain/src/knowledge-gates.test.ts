import { describe, expect, it } from "vitest";
import { assertionTransition } from "./assertion-state";
import {
	detectConflictPairs,
	draftFactProblems,
	effectiveValidUntil,
	factBlockers,
	type GeoConflictCandidate,
	type GeoFactState,
	type GeoKnowledgeSourceFacts,
	knowledgeApprovalProblem,
} from "./knowledge-gates";

const now = new Date("2026-06-01T00:00:00Z");
const past = new Date("2026-05-01T00:00:00Z");
const future = new Date("2027-01-01T00:00:00Z");

const page: GeoKnowledgeSourceFacts = { kind: "PAGE_VERSION", pageStatus: "ACTIVE" };
const manual: GeoKnowledgeSourceFacts = {
	kind: "ASSET",
	assetApproval: "APPROVED",
	assetScan: "CLEAN",
	assetValidUntil: future,
	assetPublicationScope: "PUBLIC",
};

function candidate(overrides: Partial<GeoConflictCandidate>): GeoConflictCandidate {
	return {
		id: "a",
		entityId: "product-1",
		fieldPath: "params.ratedVoltage",
		claimType: "TECH_PARAMETER",
		claimText: "额定电压 12kV",
		normalizedValue: "12kV",
		status: "PENDING_REVIEW",
		...overrides,
	};
}

describe("conflict detection", () => {
	it("pairs a new website value with the approved manual value of the same field", () => {
		const pairs = detectConflictPairs([
			candidate({ id: "approved", status: "APPROVED", normalizedValue: "12kV" }),
			candidate({ id: "crawled", normalizedValue: "24kV" }),
		]);
		expect(pairs).toEqual([{ candidateId: "crawled", approvedId: "approved" }]);
	});

	it("does not treat spacing or full-width forms as a different value", () => {
		const pairs = detectConflictPairs([
			candidate({ id: "approved", status: "APPROVED", normalizedValue: "12 kV" }),
			candidate({ id: "crawled", normalizedValue: "１２kv" }),
		]);
		expect(pairs).toEqual([]);
	});

	it("ignores other fields, other entities, settled candidates and facts without a field", () => {
		const pairs = detectConflictPairs([
			candidate({ id: "approved", status: "APPROVED" }),
			candidate({ id: "other-field", fieldPath: "params.ratedCurrent", normalizedValue: "630A" }),
			candidate({ id: "other-entity", entityId: "product-2", normalizedValue: "24kV" }),
			candidate({ id: "rejected", status: "REJECTED", normalizedValue: "24kV" }),
			candidate({ id: "superseded", status: "SUPERSEDED", normalizedValue: "24kV" }),
			candidate({ id: "no-field", fieldPath: null, normalizedValue: "24kV" }),
		]);
		expect(pairs).toEqual([]);
	});
});

describe("high-risk approval gate", () => {
	const highRisk = { status: "PENDING_REVIEW" as const, riskLevel: "HIGH" as const, authorId: "author" };

	it("refuses a high-risk fact backed only by a web page", () => {
		const result = assertionTransition({
			assertion: highRisk,
			action: "APPROVE",
			actor: { kind: "principal", id: "reviewer", roles: ["tech_reviewer"] },
			payload: { basis: "核对官网", publicationScope: "PUBLIC", sourceRef: [page], hasOriginalDocument: false },
			now,
		});
		expect(result).toMatchObject({ ok: false, code: "EVIDENCE_REQUIRED" });
	});

	it("lets only a technical or marketing reviewer confirm a high-risk fact", () => {
		const base = {
			assertion: { riskLevel: "NORMAL" as const, claimType: "CERTIFICATE", frozen: false },
			publicationScope: "PUBLIC" as const,
			sources: [page, manual],
			now,
		};
		expect(knowledgeApprovalProblem({ ...base, actorRoles: ["knowledge_reviewer"] })).toMatchObject({
			code: "FORBIDDEN",
		});
		expect(knowledgeApprovalProblem({ ...base, actorRoles: ["tech_reviewer"] })).toBeNull();
		expect(knowledgeApprovalProblem({ ...base, actorRoles: ["marketing_reviewer"] })).toBeNull();
	});

	it("blocks a frozen fact and a scope wider than its sources allow", () => {
		const internalOnly: GeoKnowledgeSourceFacts = { ...manual, assetPublicationScope: "INTERNAL" };
		expect(
			knowledgeApprovalProblem({
				assertion: { riskLevel: "NORMAL", claimType: "FAQ", frozen: true },
				actorRoles: ["knowledge_reviewer"],
				publicationScope: "INTERNAL",
				sources: [page],
				now,
			}),
		).toMatchObject({ code: "CONFLICT" });
		expect(
			knowledgeApprovalProblem({
				assertion: { riskLevel: "NORMAL", claimType: "FAQ", frozen: false },
				actorRoles: ["knowledge_reviewer"],
				publicationScope: "PUBLIC",
				sources: [internalOnly],
				now,
			}),
		).toMatchObject({ code: "VALIDATION_ERROR" });
	});

	it("does not count an expired, rejected or infected document as a live source", () => {
		const expired = { ...manual, assetValidUntil: past };
		const rejected = { ...manual, assetApproval: "REJECTED" as const };
		expect(
			knowledgeApprovalProblem({
				assertion: { riskLevel: "HIGH", claimType: "TECH_PARAMETER", frozen: false },
				actorRoles: ["tech_reviewer"],
				publicationScope: "INTERNAL",
				sources: [expired, rejected],
				now,
			}),
		).toMatchObject({ code: "EVIDENCE_REQUIRED" });
	});
});

describe("expiry gate", () => {
	const approved: GeoFactState = {
		status: "APPROVED",
		publicationScope: "PUBLIC",
		validUntil: future,
		frozen: false,
		openConflicts: 0,
	};

	it("keeps an expired fact out of a draft even while it still reads APPROVED", () => {
		expect(factBlockers(approved, now)).toEqual([]);
		expect(factBlockers({ ...approved, validUntil: past }, now)).toEqual(["EXPIRED"]);
	});

	it("reports every reason a cited fact can no longer back a release", () => {
		const current = new Map<string, GeoFactState>([
			["ok", approved],
			["stale", { ...approved, validUntil: past }],
			["internal", { ...approved, publicationScope: "INTERNAL", frozen: true }],
		]);
		const problems = draftFactProblems(
			[
				{ ref: "F1", assertionId: "ok" },
				{ ref: "F2", assertionId: "stale" },
				{ ref: "F3", assertionId: "internal" },
				{ ref: "F4", assertionId: "gone" },
			],
			current,
			now,
		);
		expect(problems).toEqual([
			{ ref: "F2", assertionId: "stale", blockers: ["EXPIRED"] },
			{ ref: "F3", assertionId: "internal", blockers: ["NOT_PUBLIC", "FROZEN"] },
			{ ref: "F4", assertionId: "gone", blockers: ["MISSING"] },
		]);
	});

	it("ends a high-risk fact with the last original document that supports it", () => {
		const sooner = { ...manual, assetValidUntil: new Date("2026-09-01T00:00:00Z") };
		expect(effectiveValidUntil({ explicit: null, riskLevel: "HIGH", sources: [page, sooner, manual], now })).toEqual(
			future,
		);
		expect(effectiveValidUntil({ explicit: null, riskLevel: "HIGH", sources: [page, sooner], now })).toEqual(
			sooner.assetValidUntil,
		);
		expect(effectiveValidUntil({ explicit: null, riskLevel: "NORMAL", sources: [page, sooner], now })).toBeNull();
		expect(effectiveValidUntil({ explicit: past, riskLevel: "HIGH", sources: [page, manual], now })).toEqual(past);
	});
});
