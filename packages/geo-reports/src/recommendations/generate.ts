import {
	GEO_PLATFORM_LABELS,
	type GeoCitationOwner,
	type GeoCitedContentType,
	type GeoClaimKind,
	type GeoClaimMatchStatus,
	type GeoClaimVerdict,
	type GeoFindingSeverity,
	type GeoPlatform,
	type GeoPriority,
	type GeoRecommendationKind,
	type GeoRecommendationStatus,
	type GeoSurfaceMode,
} from "@workspace/geo-domain";
import { computeInsights } from "../insights";
import { type CompetitorRef, evaluatedValidSamples, type MetricSample } from "../metrics";
import { siteDomainOf, thirdPartyPlatformOf } from "./classify";
import { GEO_CITED_CONTENT_TYPE_LABELS, GEO_ON_SITE_CONTENT_TYPES } from "./labels";

/** Stamped on every generated item; bump when a rule below changes what it produces. */
export const GEO_RECOMMENDATIONS_VERSION = "recommendations-v1";

/** How far back the answers behind a recommendation reach. */
export const GEO_RECOMMENDATION_WINDOW_DAYS = 28;

export interface RecommendationPrompt {
	promptId: string;
	questionText: string;
	priority: GeoPriority | null;
	buyerRoleTitle: string | null;
	/** 1 is the most important role, as in the buyer-role list. */
	buyerRolePriority: number | null;
	productLine: string | null;
}

export interface RecommendationCitation {
	observationId: string;
	ordinal: number;
	/** Normalized where possible; the classification cache is keyed by the same value. */
	url: string;
	title: string | null;
}

export interface SiteContentItem {
	contentType: GeoCitedContentType;
	title: string;
	pageId: string | null;
	url: string | null;
}

export interface OwnProduct {
	name: string;
	model: string | null;
}

export interface OpenFinding {
	id: string;
	ruleId: string;
	ruleTitle: string;
	recommendation: string | null;
	severity: GeoFindingSeverity;
	pageId: string | null;
	pageUrl: string | null;
}

export interface ClaimIssue {
	id: string;
	observationId: string;
	claimText: string;
	kind: GeoClaimKind;
	extractedValue: string | null;
	referenceValue: string | null;
	verdict: GeoClaimVerdict;
	matchStatus: GeoClaimMatchStatus;
	assertionId: string | null;
}

export interface RecommendationInput {
	samples: readonly MetricSample[];
	competitors: readonly CompetitorRef[];
	prompts: ReadonlyMap<string, RecommendationPrompt>;
	citations: readonly RecommendationCitation[];
	classifications: ReadonlyMap<string, GeoCitedContentType>;
	siteContent: readonly SiteContentItem[];
	ownProducts: readonly OwnProduct[];
	findings: readonly OpenFinding[];
	claims: readonly ClaimIssue[];
}

export interface LostQuestionEvidence {
	promptId: string;
	questionText: string;
	buyerRole: string | null;
	platform: GeoPlatform;
	surfaceMode: GeoSurfaceMode;
	competitorIds: string[];
	observationIds: string[];
}

export interface CitedPageEvidence {
	url: string;
	title: string | null;
	domain: string | null;
	contentType: GeoCitedContentType;
	owner: GeoCitationOwner;
	observationId: string;
}

export type RecommendationEvidence = {
	promptIds: string[];
	observationIds: string[];
	competitorIds: string[];
	citedUrls: string[];
	sitePageIds?: string[];
	findingIds?: string[];
	/** The size of the problem (lost questions, pages, wrong answers): what "the evidence grew" is measured in. */
	measure: number;
	/** `measure` when someone dismissed or converted the item; growth is judged against it. */
	decidedMeasure?: number;
	action: string;
	lostQuestions?: LostQuestionEvidence[];
	competitors?: CompetitorRef[];
	citedPages?: CitedPageEvidence[];
	siteHas?: { count: number; examples: { title: string; url: string | null }[] };
	pages?: { pageId: string | null; url: string | null }[];
	claims?: { id: string; observationId: string; claimText: string; verdict: GeoClaimVerdict }[];
	platform?: string;
};

export interface RecommendationDraft {
	kind: GeoRecommendationKind;
	subjectKey: string;
	title: string;
	summary: string;
	contentType: GeoCitedContentType | null;
	impactScore: number;
	priority: GeoPriority;
	evidence: RecommendationEvidence;
}

const PROMPT_PRIORITY_WEIGHT: Record<GeoPriority, number> = { P0: 4, P1: 3, P2: 2, P3: 1 };

/** How much one lost question on one platform counts: the question's priority, raised for the roles that decide. */
export function lostQuestionWeight(priority: GeoPriority | null, buyerRolePriority: number | null): number {
	const base = priority ? PROMPT_PRIORITY_WEIGHT[priority] : PROMPT_PRIORITY_WEIGHT.P2;
	const role = buyerRolePriority === null ? 1 : buyerRolePriority <= 2 ? 1.5 : buyerRolePriority <= 4 ? 1.25 : 1;
	return base * role;
}

export function priorityFromImpact(impact: number): GeoPriority {
	if (impact >= 12) return "P0";
	if (impact >= 6) return "P1";
	if (impact >= 2) return "P2";
	return "P3";
}

const round = (value: number) => Math.round(value * 100) / 100;

interface LostCell extends LostQuestionEvidence {
	weight: number;
	productKey: string | null;
	productLabel: string | null;
}

function lowerIncludes(haystack: string, needle: string | null | undefined): boolean {
	return Boolean(needle && needle.trim().length >= 2 && haystack.toLowerCase().includes(needle.trim().toLowerCase()));
}

function productOf(
	prompt: RecommendationPrompt | undefined,
	questionText: string,
	products: readonly OwnProduct[],
): { key: string; label: string; own: OwnProduct | null } | null {
	const text = `${questionText} ${prompt?.productLine ?? ""}`;
	const byModel = products.find((product) => lowerIncludes(text, product.model));
	const own = byModel ?? products.find((product) => lowerIncludes(text, product.name)) ?? null;
	if (own) {
		const label = own.model && !own.name.includes(own.model) ? `${own.model} ${own.name}` : own.name;
		return { key: (own.model ?? own.name).toLowerCase(), label, own };
	}
	if (prompt?.productLine) return { key: prompt.productLine.toLowerCase(), label: prompt.productLine, own: null };
	return null;
}

/**
 * Questions lost to a competitor: in a platform's latest round the answers name a
 * competitor while we stay below the stable-mention bar. Only evaluated valid samples
 * count, each platform and surface mode on its own.
 */
function lostCells(input: RecommendationInput): LostCell[] {
	const byId = new Map(input.samples.map((sample) => [sample.observationId, sample]));
	const { gaps } = computeInsights({ samples: input.samples, slots: [], competitors: input.competitors });
	const cells: LostCell[] = [];
	for (const gap of gaps) {
		if (gap.competitorIds.length === 0) continue;
		const winning = gap.observationIds.filter((id) => {
			const evaluation = byId.get(id)?.evaluation;
			return evaluation && !evaluation.brandMentioned && evaluation.competitorHits.some((hit) => hit.mentioned);
		});
		if (winning.length === 0) continue;
		const prompt = input.prompts.get(gap.promptId);
		const product = productOf(prompt, gap.questionText, input.ownProducts);
		cells.push({
			promptId: gap.promptId,
			questionText: gap.questionText,
			buyerRole: prompt?.buyerRoleTitle ?? null,
			platform: gap.platform,
			surfaceMode: gap.surfaceMode,
			competitorIds: gap.competitorIds,
			observationIds: winning,
			weight: lostQuestionWeight(prompt?.priority ?? gap.priority, prompt?.buyerRolePriority ?? null),
			productKey: product?.key ?? null,
			productLabel: product?.label ?? null,
		});
	}
	return cells;
}

interface ResolvedCitation extends CitedPageEvidence {
	entityId: string | null;
}

function citationsByObservation(input: RecommendationInput): Map<string, ResolvedCitation[]> {
	const samples = new Map(input.samples.map((sample) => [sample.observationId, sample]));
	const result = new Map<string, ResolvedCitation[]>();
	for (const citation of input.citations) {
		const sample = samples.get(citation.observationId);
		const attribution = sample?.evaluation?.citations.find((entry) => entry.ordinal === citation.ordinal);
		const contentType = input.classifications.get(citation.url);
		if (!sample || !contentType) continue;
		const list = result.get(citation.observationId) ?? [];
		list.push({
			url: citation.url,
			title: citation.title,
			domain: siteDomainOf(citation.url),
			contentType,
			owner: attribution?.owner ?? "THIRD_PARTY",
			entityId: attribution?.entityId ?? null,
			observationId: citation.observationId,
		});
		result.set(citation.observationId, list);
	}
	return result;
}

interface Bucket {
	cells: Map<string, LostCell>;
	pages: Map<string, CitedPageEvidence>;
}

function addToBucket(buckets: Map<string, Bucket>, key: string, cell: LostCell, page: CitedPageEvidence | null) {
	const bucket = buckets.get(key) ?? { cells: new Map(), pages: new Map() };
	bucket.cells.set(`${cell.promptId}|${cell.platform}|${cell.surfaceMode}`, cell);
	if (page && !bucket.pages.has(page.url)) bucket.pages.set(page.url, page);
	buckets.set(key, bucket);
}

const unique = <T>(values: Iterable<T>) => [...new Set(values)];

function listNames(names: readonly string[], limit = 3): string {
	const shown = names.slice(0, limit).join("、");
	return names.length > limit ? `${shown}等 ${names.length} 家` : shown;
}

function lostSummary(cells: readonly LostCell[], competitorNames: Map<string, string>): string {
	const questions = unique(cells.map((cell) => cell.promptId)).length;
	const platforms = unique(cells.map((cell) => GEO_PLATFORM_LABELS[cell.platform]));
	const roles = unique(cells.map((cell) => cell.buyerRole).filter((role): role is string => Boolean(role)));
	const competitors = unique(cells.flatMap((cell) => cell.competitorIds))
		.map((id) => competitorNames.get(id))
		.filter((name): name is string => Boolean(name));
	const whom = roles.length > 0 ? `，提问的是${listNames(roles)}` : "";
	return `有 ${questions} 个问题在${platforms.join("、")}上，AI 提到了${listNames(competitors)}，却没有提到我们${whom}。`;
}

function evidenceFromCells(cells: readonly LostCell[], competitors: readonly CompetitorRef[]) {
	const competitorIds = unique(cells.flatMap((cell) => cell.competitorIds));
	return {
		promptIds: unique(cells.map((cell) => cell.promptId)),
		observationIds: unique(cells.flatMap((cell) => cell.observationIds)),
		competitorIds,
		competitors: competitors.filter((competitor) => competitorIds.includes(competitor.entityId)),
		lostQuestions: cells.map(({ weight: _weight, productKey: _key, productLabel: _label, ...rest }) => rest),
		measure: cells.length,
	};
}

interface GapCopy {
	title: string;
	action: string;
}

function contentGapCopy(type: GeoCitedContentType, product: string | null, siteCount: number): GapCopy {
	const has = siteCount > 0;
	switch (type) {
		case "PRODUCT_SPEC":
			return has
				? {
						title: `完善${product ?? "产品"}参数页：写清型号、技术参数和执行标准`,
						action: `官网已有${product ?? "产品"}页面，但 AI 引用的是别家的参数页。把型号、额定参数、执行标准、适用场景写成文字（不要只放图片），并提供可下载的产品手册。`,
					}
				: {
						title: `补充${product ?? "主要产品"}产品手册 / 参数页`,
						action: `为${product ?? "主要产品"}建立单独的产品页：型号、额定参数、执行标准、适用场景和可下载的产品手册，参数以文字呈现。`,
					};
		case "CASE_STUDY":
			return has
				? {
						title: "充实现有案例：写明项目、时间、规模和客户行业",
						action:
							"现有案例信息太少，AI 更愿意引用写得具体的案例。每个案例写清项目名称、交付时间、规模（台数/容量）、客户行业和使用的产品型号（需确认客户同意披露）。",
					}
				: {
						title: "补充可核实的成功交付案例",
						action:
							"官网还没有案例。补充已交付项目：项目名称、交付时间、规模（台数/容量）、客户行业和使用的产品型号（需确认客户同意披露）。",
					};
		case "QUALIFICATION":
			return {
				title: has ? "完善资质页：证书编号、发证机构和有效期" : "在官网公开资质证书和检测报告",
				action: "整理 3C 认证、型式试验报告、体系认证等资质，在官网列出证书名称、编号、发证机构和有效期，并附扫描件。",
			};
		case "SELECTION_GUIDE":
			return {
				title: "补充选型指南：按使用场景说明怎么选",
				action:
					"针对采购和设计人员常问的问题，写选型说明：不同使用场景该选哪种柜型、关键参数怎么定、常见误区，内容需技术审核。",
			};
		case "COMPANY_PROFILE":
			return {
				title: "完善公司介绍：成立时间、产能、主营产品和服务区域",
				action: "在“关于我们”写清成立时间、厂房和产能、主营产品、服务区域和主要客户行业，用文字而不是只放宣传图。",
			};
		default:
			return {
				title: "定期发布项目动态和企业新闻",
				action: "每月发布项目交付、新品和资质更新等动态，标题写清项目或产品名称。",
			};
	}
}

function eachLostCitation(
	cells: readonly LostCell[],
	citations: Map<string, ResolvedCitation[]>,
	visit: (cell: LostCell, citation: ResolvedCitation) => void,
) {
	for (const cell of cells) {
		for (const citation of cell.observationIds.flatMap((id) => citations.get(id) ?? [])) visit(cell, citation);
	}
}

const sumWeights = (cells: readonly LostCell[]) => cells.reduce((sum, cell) => sum + cell.weight, 0);

function productKeyOf(product: OwnProduct): string {
	return (product.model ?? product.name).toLowerCase();
}

function siteContentFor(
	input: RecommendationInput,
	type: GeoCitedContentType,
	product: { key: string | null; label: string | null },
): SiteContentItem[] {
	const ofType = input.siteContent.filter((item) => item.contentType === type);
	if (type !== "PRODUCT_SPEC" || !product.key) return ofType;
	const own = input.ownProducts.find((entry) => productKeyOf(entry) === product.key);
	const terms = [own?.model, own?.name, product.label].filter((term): term is string => Boolean(term));
	return ofType.filter((item) => terms.some((term) => lowerIncludes(item.title, term)));
}

interface GapSubject {
	type: GeoCitedContentType;
	productKey: string | null;
	product: string | null;
}

function gapSubject(type: GeoCitedContentType, cell: LostCell): { key: string; subject: GapSubject } {
	if (type !== "PRODUCT_SPEC") return { key: type, subject: { type, productKey: null, product: null } };
	return {
		key: `PRODUCT_SPEC:${cell.productKey ?? "general"}`,
		subject: { type, productKey: cell.productKey, product: cell.productLabel },
	};
}

function isCompetitorSiteContent(citation: ResolvedCitation): boolean {
	if (citation.owner === "OWN" || !GEO_ON_SITE_CONTENT_TYPES.includes(citation.contentType)) return false;
	return citation.owner === "COMPETITOR" || !thirdPartyPlatformOf(citation.url);
}

function contentGapDraft(
	input: RecommendationInput,
	key: string,
	subject: GapSubject,
	bucket: Bucket,
	competitorNames: Map<string, string>,
): RecommendationDraft {
	const cellList = [...bucket.cells.values()];
	const onSite = siteContentFor(input, subject.type, { key: subject.productKey, label: subject.product });
	const copy = contentGapCopy(subject.type, subject.product, onSite.length);
	const pages = [...bucket.pages.values()];
	const typeLabel = GEO_CITED_CONTENT_TYPE_LABELS[subject.type];
	const cited = pages.length > 0 ? `这些回答引用了 ${pages.length} 个${typeLabel}页面，` : "这些回答没有给出来源，";
	const site = onSite.length > 0 ? `官网目前有 ${onSite.length} 个相关页面。` : "官网目前没有这类内容。";
	const impact = sumWeights(cellList);
	return {
		kind: "CONTENT_GAP",
		subjectKey: key,
		title: copy.title,
		summary: `${lostSummary(cellList, competitorNames)}${cited}${site}`,
		contentType: subject.type,
		impactScore: round(impact),
		priority: priorityFromImpact(impact),
		evidence: {
			...evidenceFromCells(cellList, input.competitors),
			citedUrls: pages.map((page) => page.url),
			citedPages: pages.slice(0, 20),
			sitePageIds: unique(onSite.map((item) => item.pageId).filter((id): id is string => Boolean(id))),
			siteHas: {
				count: onSite.length,
				examples: onSite.slice(0, 5).map((item) => ({ title: item.title, url: item.url })),
			},
			action: copy.action,
		},
	};
}

function contentGaps(
	input: RecommendationInput,
	cells: readonly LostCell[],
	citations: Map<string, ResolvedCitation[]>,
	competitorNames: Map<string, string>,
): RecommendationDraft[] {
	const buckets = new Map<string, Bucket>();
	const subjects = new Map<string, GapSubject>();
	const add = (type: GeoCitedContentType, cell: LostCell, page: CitedPageEvidence | null) => {
		const { key, subject } = gapSubject(type, cell);
		subjects.set(key, subject);
		addToBucket(buckets, key, cell, page);
	};
	eachLostCitation(cells, citations, (cell, citation) => {
		if (isCompetitorSiteContent(citation)) add(citation.contentType, cell, citation);
	});

	// A lost question about one of our products with no product page at all is a gap even when the answers cite nothing.
	const ownKeys = new Set(input.ownProducts.map(productKeyOf));
	for (const cell of cells) {
		if (!cell.productKey || !ownKeys.has(cell.productKey)) continue;
		const pages = siteContentFor(input, "PRODUCT_SPEC", { key: cell.productKey, label: cell.productLabel });
		if (pages.length === 0) add("PRODUCT_SPEC", cell, null);
	}

	return [...buckets].flatMap(([key, bucket]) => {
		const subject = subjects.get(key);
		return subject ? [contentGapDraft(input, key, subject, bucket, competitorNames)] : [];
	});
}

const CHANNEL_MIN_ANSWERS = 2;

function channelCopy(type: GeoCitedContentType, name: string): GapCopy {
	switch (type) {
		case "QA_COMMUNITY":
			return {
				title: `在${name}回答采购和选型相关问题`,
				action: `用企业认证账号在${name}回答与我们产品相关的选型、价格和厂家对比问题，答案写清产品型号和可核实的案例，并链接到官网对应页面。`,
			};
		case "DIRECTORY_LISTING":
			return {
				title: `在${name}完善企业和产品信息`,
				action: `在${name}开通或更新企业页：公司全称、主营产品型号、资质和联系方式与官网保持一致。`,
			};
		case "COMPANY_PROFILE":
			return {
				title: `建立或完善${name}词条`,
				action: `在${name}创建或更新企业词条，内容与官网“关于我们”一致，并引用可核实的资质和新闻报道作为参考资料。`,
			};
		default:
			return {
				title: `在${name}发布企业和项目文章`,
				action: `在${name}发布项目交付、技术选型和产品介绍文章，文中写清公司全称和产品型号。`,
			};
	}
}

interface Channel {
	domain: string;
	name: string;
	type: GeoCitedContentType;
}

/** A third-party platform, or any third-party page of a platform kind (Q&A, media, directory). */
function channelOf(citation: ResolvedCitation): Channel | null {
	if (citation.owner !== "THIRD_PARTY") return null;
	const platform = thirdPartyPlatformOf(citation.url);
	if (platform) return { domain: platform.domain, name: platform.name, type: platform.contentType };
	const offSite = !GEO_ON_SITE_CONTENT_TYPES.includes(citation.contentType) && citation.contentType !== "OTHER";
	return offSite && citation.domain
		? { domain: citation.domain, name: citation.domain, type: citation.contentType }
		: null;
}

function domainsCitingUs(input: RecommendationInput, citations: Map<string, ResolvedCitation[]>): Set<string> {
	const domains = new Set<string>();
	for (const sample of evaluatedValidSamples(input.samples).evaluated) {
		if (!sample.evaluation.brandMentioned) continue;
		for (const citation of citations.get(sample.observationId) ?? []) {
			const domain = thirdPartyPlatformOf(citation.url)?.domain ?? citation.domain;
			if (domain) domains.add(domain);
		}
	}
	return domains;
}

function thirdPartyChannels(
	input: RecommendationInput,
	cells: readonly LostCell[],
	citations: Map<string, ResolvedCitation[]>,
	competitorNames: Map<string, string>,
): RecommendationDraft[] {
	const buckets = new Map<string, Bucket>();
	const channels = new Map<string, Channel>();
	eachLostCitation(cells, citations, (cell, citation) => {
		const channel = channelOf(citation);
		if (!channel) return;
		channels.set(channel.domain, channels.get(channel.domain) ?? channel);
		addToBucket(buckets, channel.domain, cell, citation);
	});
	const citingUs = domainsCitingUs(input, citations);

	return [...buckets].flatMap(([domain, bucket]): RecommendationDraft[] => {
		const channel = channels.get(domain);
		const pages = [...bucket.pages.values()];
		const answers = unique(pages.map((page) => page.observationId)).length;
		if (!channel || answers < CHANNEL_MIN_ANSWERS || citingUs.has(domain)) return [];
		const copy = channelCopy(channel.type, channel.name);
		const cellList = [...bucket.cells.values()];
		const impact = sumWeights(cellList);
		return [
			{
				kind: "THIRD_PARTY_CHANNEL",
				subjectKey: domain,
				title: copy.title,
				summary: `${lostSummary(cellList, competitorNames)}其中 ${answers} 个回答引用了${channel.name}上的内容，而提到我们的回答从没引用过${channel.name}。`,
				contentType: channel.type,
				impactScore: round(impact),
				priority: priorityFromImpact(impact),
				evidence: {
					...evidenceFromCells(cellList, input.competitors),
					citedUrls: pages.map((page) => page.url),
					citedPages: pages.slice(0, 20),
					platform: channel.name,
					action: copy.action,
				},
			},
		];
	});
}

const SEVERITY_WEIGHT: Record<GeoFindingSeverity, number> = { HIGH: 3, MEDIUM: 1.5, LOW: 0.5, INFO: 0 };

function siteFixes(findings: readonly OpenFinding[]): RecommendationDraft[] {
	const byRule = new Map<string, OpenFinding[]>();
	for (const finding of findings) {
		if (SEVERITY_WEIGHT[finding.severity] === 0) continue;
		const group = byRule.get(finding.ruleId) ?? [];
		group.push(finding);
		byRule.set(finding.ruleId, group);
	}
	const drafts: RecommendationDraft[] = [];
	for (const [ruleId, group] of byRule) {
		const first = group[0];
		if (!first) continue;
		const pageIds = unique(group.map((finding) => finding.pageId).filter((id): id is string => Boolean(id)));
		const siteWide = group.some((finding) => finding.pageId === null);
		const affected = Math.max(pageIds.length, 1);
		const impact = SEVERITY_WEIGHT[first.severity] * (1 + Math.log2(affected));
		drafts.push({
			kind: "SITE_FIX",
			subjectKey: ruleId,
			title: first.ruleTitle,
			summary: siteWide ? "影响整个网站。" : `官网有 ${pageIds.length} 个页面存在这个问题。`,
			contentType: null,
			impactScore: round(impact),
			priority: priorityFromImpact(impact),
			evidence: {
				promptIds: [],
				observationIds: [],
				competitorIds: [],
				citedUrls: [],
				findingIds: group.map((finding) => finding.id),
				sitePageIds: pageIds,
				pages: group.slice(0, 20).map((finding) => ({ pageId: finding.pageId, url: finding.pageUrl })),
				measure: affected,
				action: first.recommendation ?? first.ruleTitle,
			},
		});
	}
	return drafts;
}

function claimKey(claim: ClaimIssue): string {
	if (claim.assertionId) return `assertion:${claim.assertionId}`;
	return `claim:${claim.kind}:${(claim.extractedValue ?? claim.claimText).toLowerCase()}`;
}

const isWrongClaim = (claim: ClaimIssue) =>
	claim.verdict === "ERROR" || (claim.verdict === "UNVERIFIED" && claim.matchStatus === "MISMATCH");

type ClaimEntry = { claim: ClaimIssue; sample: MetricSample };

function wrongClaimGroups(input: RecommendationInput): Map<string, ClaimEntry[]> {
	const counted = new Map(evaluatedValidSamples(input.samples).valid.map((sample) => [sample.observationId, sample]));
	const groups = new Map<string, ClaimEntry[]>();
	for (const claim of input.claims) {
		const sample = counted.get(claim.observationId);
		if (!sample || !isWrongClaim(claim)) continue;
		const key = claimKey(claim);
		groups.set(key, [...(groups.get(key) ?? []), { claim, sample }]);
	}
	return groups;
}

function factCorrectionDraft(key: string, group: ClaimEntry[], input: RecommendationInput): RecommendationDraft | null {
	const first = group[0];
	if (!first) return null;
	const confirmed = group.some((entry) => entry.claim.verdict === "ERROR");
	const answers = unique(group.map((entry) => entry.sample.observationId));
	const platforms = unique(group.map((entry) => GEO_PLATFORM_LABELS[entry.sample.platform]));
	const cells = new Map(
		group.map(({ sample }) => [`${sample.promptId}|${sample.platform}|${sample.surfaceMode}`, sample.promptId]),
	);
	const weight = [...cells.values()].reduce((sum, promptId) => {
		const prompt = input.prompts.get(promptId);
		return sum + lostQuestionWeight(prompt?.priority ?? null, prompt?.buyerRolePriority ?? null);
	}, 0);
	const impact = weight * (confirmed ? 1.5 : 1);
	const stated = first.claim.extractedValue ?? first.claim.claimText;
	const reference = first.claim.referenceValue;
	const status = confirmed ? "已由技术人员确认是错的。" : "与已审核资料不一致，等待技术人员确认。";
	return {
		kind: "FACT_CORRECTION",
		subjectKey: key,
		title: `纠正 AI 的说法：“${stated}”`,
		summary: `${platforms.join("、")}有 ${answers.length} 个回答说我们“${stated}”${reference ? `，核实过的资料是“${reference}”` : ""}。${status}`,
		contentType: null,
		impactScore: round(impact),
		priority: priorityFromImpact(impact),
		evidence: {
			promptIds: unique(group.map((entry) => entry.sample.promptId)),
			observationIds: answers,
			competitorIds: [],
			citedUrls: [],
			claims: group.slice(0, 20).map(({ claim }) => ({
				id: claim.id,
				observationId: claim.observationId,
				claimText: claim.claimText,
				verdict: claim.verdict,
			})),
			measure: answers.length,
			action: `在官网产品页和资质页用文字写明正确的信息${reference ? `（${reference}）` : ""}，并在常被引用的第三方平台同步更正。`,
		},
	};
}

function factCorrections(input: RecommendationInput): RecommendationDraft[] {
	return [...wrongClaimGroups(input)].flatMap(([key, group]) => {
		const draft = factCorrectionDraft(key, group, input);
		return draft ? [draft] : [];
	});
}

export function generateRecommendations(input: RecommendationInput): RecommendationDraft[] {
	const competitorNames = new Map(input.competitors.map((competitor) => [competitor.entityId, competitor.name]));
	const cells = lostCells(input);
	const citations = citationsByObservation(input);
	return [
		...contentGaps(input, cells, citations, competitorNames),
		...thirdPartyChannels(input, cells, citations, competitorNames),
		...siteFixes(input.findings),
		...factCorrections(input),
	].sort((a, b) => b.impactScore - a.impactScore);
}

/** Evidence that at least doubled, and by at least two, since someone set the item aside. */
export function evidenceGrewMaterially(decidedMeasure: number, measure: number): boolean {
	return measure >= Math.max(decidedMeasure * 2, decidedMeasure + 2);
}

export interface ExistingRecommendation {
	id: string;
	kind: GeoRecommendationKind;
	subjectKey: string;
	status: GeoRecommendationStatus;
	taskId: string | null;
	evidence: { measure?: number; decidedMeasure?: number };
}

export interface RecommendationWrite {
	draft: RecommendationDraft;
	existingId: string | null;
	status: GeoRecommendationStatus;
	/** True when a dismissed or converted item comes back because its evidence grew. */
	reopened: boolean;
}

/**
 * What regeneration does to stored items. Open items follow the evidence; dismissed or
 * converted ones keep their status unless the evidence grew materially since the decision.
 * Open items the evidence no longer supports are removed; decided ones are kept as history.
 */
export function reconcileRecommendations(
	existing: readonly ExistingRecommendation[],
	drafts: readonly RecommendationDraft[],
): { writes: RecommendationWrite[]; staleIds: string[] } {
	const byKey = new Map(existing.map((item) => [`${item.kind}|${item.subjectKey}`, item]));
	const seen = new Set<string>();
	const writes: RecommendationWrite[] = drafts.map((draft) => {
		const key = `${draft.kind}|${draft.subjectKey}`;
		seen.add(key);
		const current = byKey.get(key);
		if (!current) return { draft, existingId: null, status: "OPEN", reopened: false };
		if (current.status === "OPEN") return { draft, existingId: current.id, status: "OPEN", reopened: false };
		const decided = current.evidence.decidedMeasure ?? current.evidence.measure ?? 0;
		if (evidenceGrewMaterially(decided, draft.evidence.measure)) {
			return { draft, existingId: current.id, status: "OPEN", reopened: true };
		}
		return {
			draft: { ...draft, evidence: { ...draft.evidence, decidedMeasure: decided } },
			existingId: current.id,
			status: current.status,
			reopened: false,
		};
	});
	const staleIds = existing
		.filter((item) => item.status === "OPEN" && !item.taskId && !seen.has(`${item.kind}|${item.subjectKey}`))
		.map((item) => item.id);
	return { writes, staleIds };
}
