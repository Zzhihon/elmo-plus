import type {
	GeoAssertionStatus,
	GeoAssetApprovalStatus,
	GeoPublicationScope,
	GeoRiskLevel,
	GeoScanStatus,
	GeoSitePageStatus,
} from "./enums";
import type { GeoRole } from "./permissions";
import type { GeoTransitionFailureCode } from "./transition";

export const GEO_KNOWLEDGE_CLAIM_TYPES = [
	"BRAND_CLAIM",
	"COMPANY_PROFILE",
	"PRODUCT_DESCRIPTION",
	"TECH_PARAMETER",
	"STANDARD",
	"CERTIFICATE",
	"QUALIFICATION",
	"PATENT",
	"REGISTERED_CAPITAL",
	"PROJECT_RESULT",
	"PERFORMANCE",
	"CASE",
	"SERVICE_COMMITMENT",
	"FAQ",
	"NEWS",
	"OTHER",
] as const;
export type GeoKnowledgeClaimType = (typeof GEO_KNOWLEDGE_CLAIM_TYPES)[number];

/**
 * PRD 3.8 and 3.12: these need a technical or marketing owner and the customer's
 * original document; an old web page never settles them on its own.
 */
export const GEO_HIGH_RISK_CLAIM_TYPES: readonly string[] = [
	"TECH_PARAMETER",
	"STANDARD",
	"CERTIFICATE",
	"QUALIFICATION",
	"PATENT",
	"REGISTERED_CAPITAL",
	"PROJECT_RESULT",
	"PERFORMANCE",
];

export const GEO_HIGH_RISK_REVIEWER_ROLES: readonly GeoRole[] = ["tech_reviewer", "marketing_reviewer"];

const SPEC_VALUE =
	/\d+(?:\.\d+)?\s*(?:k?v|ka|a|hz|kva|kw|mw|mva|mm|cm|m|kg|t|℃|°c|%|级|项|万元|亿元|千伏|毫米|ip\d{2})(?![a-z])/i;
const HIGH_RISK_WORDS = /专利|注册资本|有效期|证书编号|认证编号|执行标准/;

export function claimRiskLevel(claimType: string, text: string, declared?: GeoRiskLevel | null): GeoRiskLevel {
	if (declared === "HIGH" || GEO_HIGH_RISK_CLAIM_TYPES.includes(claimType)) return "HIGH";
	return SPEC_VALUE.test(text.normalize("NFKC")) || HIGH_RISK_WORDS.test(text) ? "HIGH" : "NORMAL";
}

/** A stored NORMAL never downgrades a claim type the PRD names as high risk. */
export function effectiveRiskLevel(assertion: { riskLevel: GeoRiskLevel; claimType: string }): GeoRiskLevel {
	return assertion.riskLevel === "HIGH" || GEO_HIGH_RISK_CLAIM_TYPES.includes(assertion.claimType) ? "HIGH" : "NORMAL";
}

export interface GeoKnowledgeSourceFacts {
	kind: "PAGE_VERSION" | "ASSET";
	pageStatus?: GeoSitePageStatus | null;
	assetApproval?: GeoAssetApprovalStatus | null;
	assetScan?: GeoScanStatus | null;
	assetValidUntil?: Date | null;
	assetPublicationScope?: GeoPublicationScope | null;
}

function notExpired(validUntil: Date | null | undefined, now: Date): boolean {
	return !validUntil || validUntil.getTime() > now.getTime();
}

/** A page that still exists, or a document that was not rejected, infected or let lapse. */
export function isLiveSource(source: GeoKnowledgeSourceFacts, now: Date = new Date()): boolean {
	if (source.kind === "PAGE_VERSION") return source.pageStatus !== "GONE";
	return (
		source.assetApproval !== "REJECTED" &&
		source.assetScan !== "INFECTED" &&
		source.assetScan !== "PENDING" &&
		notExpired(source.assetValidUntil, now)
	);
}

/** The customer original a high-risk fact needs: confirmed by a reviewer, scanned or knowingly unscanned, in date. */
export function isUsableOriginal(source: GeoKnowledgeSourceFacts, now: Date = new Date()): boolean {
	return source.kind === "ASSET" && source.assetApproval === "APPROVED" && isLiveSource(source, now);
}

export function hasValidOriginalDocument(sources: readonly GeoKnowledgeSourceFacts[], now: Date = new Date()): boolean {
	return sources.some((source) => isUsableOriginal(source, now));
}

const SCOPE_RANK: Record<GeoPublicationScope, number> = { CONFIDENTIAL: 0, INTERNAL: 1, PUBLIC: 2 };

export function scopeAllows(widest: GeoPublicationScope, requested: GeoPublicationScope): boolean {
	return SCOPE_RANK[requested] <= SCOPE_RANK[widest];
}

/**
 * How far a fact may travel given where it came from: anything on the public
 * website may be public, a customer document no further than the scope it was
 * filed with. Null when no source is live.
 */
export function widestPublicationScope(
	sources: readonly GeoKnowledgeSourceFacts[],
	now: Date = new Date(),
): GeoPublicationScope | null {
	let widest: GeoPublicationScope | null = null;
	for (const source of sources) {
		if (!isLiveSource(source, now)) continue;
		const scope = source.kind === "PAGE_VERSION" ? "PUBLIC" : (source.assetPublicationScope ?? "CONFIDENTIAL");
		if (!widest || SCOPE_RANK[scope] > SCOPE_RANK[widest]) widest = scope;
	}
	return widest;
}

export interface GeoKnowledgeGateProblem {
	code: GeoTransitionFailureCode;
	message: string;
}

/**
 * The checks on an approval that `assertionTransition` cannot see: who may
 * confirm a high-risk fact, a freeze, and whether the sources allow the scope.
 */
export function knowledgeApprovalProblem(input: {
	assertion: { riskLevel: GeoRiskLevel; claimType: string; frozen: boolean };
	actorRoles: readonly GeoRole[];
	publicationScope: GeoPublicationScope;
	sources: readonly GeoKnowledgeSourceFacts[];
	now?: Date;
}): GeoKnowledgeGateProblem | null {
	const { assertion, actorRoles, publicationScope, sources, now = new Date() } = input;
	if (assertion.frozen) return { code: "CONFLICT", message: "事实已被冻结，解冻后才能审核通过" };
	if (
		effectiveRiskLevel(assertion) === "HIGH" &&
		!actorRoles.some((role) => GEO_HIGH_RISK_REVIEWER_ROLES.includes(role))
	) {
		return { code: "FORBIDDEN", message: "高风险事实必须由技术或市场审核人确认" };
	}
	const widest = widestPublicationScope(sources, now);
	if (!widest) return { code: "EVIDENCE_REQUIRED", message: "没有仍然有效的来源，不能审核通过" };
	if (!scopeAllows(widest, publicationScope)) {
		return { code: "VALIDATION_ERROR", message: "来源资料的可公开范围不允许该公开范围" };
	}
	return null;
}

/**
 * The date a fact stops being usable. A high-risk fact lives no longer than the
 * last of its usable originals; any fact backed only by documents lives no
 * longer than they do. The reviewer's own date can only shorten that.
 */
export function effectiveValidUntil(input: {
	explicit: Date | null;
	riskLevel: GeoRiskLevel;
	sources: readonly GeoKnowledgeSourceFacts[];
	now?: Date;
}): Date | null {
	const { explicit, riskLevel, sources, now = new Date() } = input;
	const live = sources.filter((source) => isLiveSource(source, now));
	const documents =
		riskLevel === "HIGH"
			? live.filter((source) => isUsableOriginal(source, now))
			: live.some((source) => source.kind === "PAGE_VERSION")
				? []
				: live.filter((source) => source.kind === "ASSET");
	let bound: Date | null = null;
	if (documents.length > 0 && documents.every((source) => source.assetValidUntil)) {
		bound = new Date(Math.max(...documents.map((source) => (source.assetValidUntil as Date).getTime())));
	}
	if (!explicit) return bound;
	if (!bound) return explicit;
	return explicit.getTime() < bound.getTime() ? explicit : bound;
}

export const GEO_FACT_BLOCKERS = ["NOT_APPROVED", "NOT_PUBLIC", "EXPIRED", "FROZEN", "CONFLICT", "MISSING"] as const;
export type GeoFactBlocker = (typeof GEO_FACT_BLOCKERS)[number];

export const GEO_FACT_BLOCKER_LABELS: Record<GeoFactBlocker, string> = {
	NOT_APPROVED: "未审核通过",
	NOT_PUBLIC: "不在可公开范围",
	EXPIRED: "已过有效期",
	FROZEN: "已被冻结",
	CONFLICT: "存在未解决的冲突",
	MISSING: "断言不存在",
};

export interface GeoFactState {
	status: GeoAssertionStatus;
	publicationScope: GeoPublicationScope;
	validUntil: Date | null;
	frozen: boolean;
	openConflicts: number;
}

/** Why a fact may not feed a public draft (UAT-08, PRD 3.10). Empty means it may. */
export function factBlockers(fact: GeoFactState | null | undefined, now: Date = new Date()): GeoFactBlocker[] {
	if (!fact) return ["MISSING"];
	const blockers: GeoFactBlocker[] = [];
	if (fact.status !== "APPROVED") blockers.push("NOT_APPROVED");
	if (fact.publicationScope !== "PUBLIC") blockers.push("NOT_PUBLIC");
	if (!notExpired(fact.validUntil, now)) blockers.push("EXPIRED");
	if (fact.frozen) blockers.push("FROZEN");
	if (fact.openConflicts > 0) blockers.push("CONFLICT");
	return blockers;
}

export interface GeoDraftFactProblem {
	ref: string;
	assertionId: string;
	blockers: GeoFactBlocker[];
}

/** Re-checks every fact a draft version cites against the facts as they stand now. */
export function draftFactProblems(
	claims: readonly { ref: string; assertionId: string }[],
	current: ReadonlyMap<string, GeoFactState>,
	now: Date = new Date(),
): GeoDraftFactProblem[] {
	return claims
		.map((claim) => ({
			ref: claim.ref,
			assertionId: claim.assertionId,
			blockers: factBlockers(current.get(claim.assertionId), now),
		}))
		.filter((problem) => problem.blockers.length > 0);
}

/** Statuses a new value can sit in while it waits to be compared with the approved one. */
export const GEO_CONFLICT_CANDIDATE_STATUSES: readonly GeoAssertionStatus[] = [
	"DISCOVERED",
	"PARSED",
	"PENDING_REVIEW",
	"NEEDS_EVIDENCE",
];

export interface GeoConflictCandidate {
	id: string;
	entityId: string | null;
	fieldPath: string | null;
	claimType: string;
	claimText: string;
	normalizedValue: unknown;
	status: GeoAssertionStatus;
}

function canonicalText(value: string): string {
	return value.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
}

function canonicalOf(value: unknown): unknown {
	if (typeof value === "string") return canonicalText(value);
	if (Array.isArray(value)) return value.map(canonicalOf);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([key, inner]) => [key, canonicalOf(inner)]),
		);
	}
	return value ?? null;
}

/** Spacing, width and case are not a different value. */
export function canonicalClaimValue(assertion: { normalizedValue: unknown; claimText: string }): string {
	const value =
		assertion.normalizedValue === null || assertion.normalizedValue === undefined
			? assertion.claimText
			: assertion.normalizedValue;
	return JSON.stringify(canonicalOf(value));
}

function conflictKey(assertion: GeoConflictCandidate): string | null {
	if (!assertion.entityId || !assertion.fieldPath) return null;
	return `${assertion.entityId}\u0000${assertion.fieldPath}\u0000${assertion.claimType}`;
}

/**
 * Same entity, same field, same claim type, a different value than an approved
 * fact: that pair goes to review. Nothing here changes either side.
 */
export function detectConflictPairs(
	assertions: readonly GeoConflictCandidate[],
): { candidateId: string; approvedId: string }[] {
	const groups = new Map<string, GeoConflictCandidate[]>();
	for (const assertion of assertions) {
		const key = conflictKey(assertion);
		if (!key) continue;
		const group = groups.get(key) ?? [];
		group.push(assertion);
		groups.set(key, group);
	}
	const pairs: { candidateId: string; approvedId: string }[] = [];
	for (const group of groups.values()) {
		const approved = group.filter((assertion) => assertion.status === "APPROVED");
		const candidates = group.filter((assertion) => GEO_CONFLICT_CANDIDATE_STATUSES.includes(assertion.status));
		for (const candidate of candidates) {
			const value = canonicalClaimValue(candidate);
			for (const fact of approved) {
				if (canonicalClaimValue(fact) !== value) pairs.push({ candidateId: candidate.id, approvedId: fact.id });
			}
		}
	}
	return pairs;
}
