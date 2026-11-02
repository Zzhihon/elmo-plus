import {
	GEO_PLATFORM_LABELS,
	GEO_SURFACE_MODE_LABELS,
	GEO_VERIFICATION_LABELS,
	type GeoPlatform,
	type GeoSurfaceMode,
	type GeoTaskState,
	type GeoVerificationStatus,
} from "@workspace/geo-domain";
import { toCsv } from "./csv";
import type { Insights } from "./insights";
import { type CompetitorRef, formatMetric, type MetricValue } from "./metrics";

export const GEO_REPORT_FORMAT = "elmo-geo-report/1";

export interface ReportTarget {
	id: string;
	platform: GeoPlatform;
	surfaceMode: GeoSurfaceMode;
	provider: string;
	modelId: string | null;
	verificationStatus: GeoVerificationStatus;
}

export interface ReportTask {
	id: string;
	title: string;
	state: GeoTaskState;
	priority: string;
	publishedUrl: string | null;
	publishedAt: string | null;
	afterBatchId: string | null;
}

export interface ReportBusinessInputs {
	approvedAssertions: number;
	approvedInPeriod: number;
	publishedContentInPeriod: number;
	tasksPublishedInPeriod: number;
}

export interface ReportSnapshot {
	format: typeof GEO_REPORT_FORMAT;
	metricVersion: string;
	title: string;
	generatedAt: string;
	period: { start: string; end: string; label: string; timezone: "Asia/Shanghai" };
	conditions: {
		promptSet: { id: string; name: string; version: number } | null;
		evaluatorVersions: string[];
		targets: ReportTarget[];
	};
	methodology: string[];
	insights: Insights;
	competitors: CompetitorRef[];
	findings: string[];
	tasks: { executed: ReportTask[]; open: ReportTask[] };
	risks: string[];
	nextPlan: string[];
	notes: string | null;
	businessInputs: ReportBusinessInputs;
	intermediateResults: string[];
	businessOutcomes: string[];
	reviewPoolPending: number;
	/** App-relative links to the observations behind each cell's figures. */
	evidenceLinks: { platform: GeoPlatform; surfaceMode: GeoSurfaceMode; path: string }[];
	/** The exact evaluation version every figure used: [observationId, evaluationId, version]. */
	evaluationRefs: [string, string, number][];
}

const ORDER_CLAIM =
	/订单(量|数)?(的)?(显著|明显|大幅)?(增长|增加|提升|上升|上涨|翻倍)|(增加|带来|提升|拉动|促成|带动)了?[^。；\n]{0,6}(订单|成交|销售额|营收)|(销售额|营收|成交量|成交额|签单量?)(的)?(显著|明显|大幅)?(增长|增加|提升|上升)/;

/**
 * Null when the text is fine. A report may describe inputs and visibility, but no
 * report text may claim the work raised orders or revenue: nothing here measures that.
 */
export function unattributedClaimProblem(text: string): string | null {
	const match = ORDER_CLAIM.exec(text);
	return match ? `“${match[0]}”属于未经归因的业务结果表述，报告中不能使用` : null;
}

export function cellLabel(platform: GeoPlatform, surfaceMode: GeoSurfaceMode): string {
	return `${GEO_PLATFORM_LABELS[platform]} · ${GEO_SURFACE_MODE_LABELS[surfaceMode]}`;
}

function counted(value: MetricValue): string {
	if (value.status === "NO_DATA") return `数据不足（${value.reason}）`;
	return `${formatMetric(value)}（${value.numerator}/${value.denominator}${value.lowSample ? "，样本量低" : ""}）`;
}

export function methodology(promptSet: ReportSnapshot["conditions"]["promptSet"]): string[] {
	return [
		`测试样本为固定问法集合${promptSet ? `“${promptSet.name}” v${promptSet.version}` : ""}，不代表平台总体真实用户的提问分布。`,
		"指标按平台与采样方式分别计算，不跨“用户界面实测 / 模型 API 代理评测 / 人工证据”聚合；跨平台数字仅为内部概览的等权平均。",
		"有效样本只包含完整回答；被拒绝、限流、失败、不可用与截断的采样不计入任何比率的分母，也不会被算作“未提及”。重采样按同一计划位次去重。",
		"品牌提及按当时生效的品牌词典版本做确定性别名匹配；推荐、负面判断由规则得出，模型判断只用于发现分歧，存疑结果进入人工复核，复核结论以新评估版本保存。",
		"推荐率只计规则或人工确认的明确推荐；前三率只在可判定排序的回答中计算；错误描述率只计经技术审核证实的错误，无法核实的陈述标为待核实，不计为错误。",
		"同一问法的随机波动不能证明因果关系；至少连续两轮同向变化才标记为持续改善，其余写作“观察到的变化”。比较条件（问法集版本、平台、采样方式、地区/语言、评估规则版本）变化处在趋势中标为断点。",
	];
}

export function buildFindings(insights: Insights, competitors: readonly CompetitorRef[]): string[] {
	if (insights.noData) {
		return ["本期所有平台均没有有效样本，无法计算任何比率；请先确认采样目标可用后再解读。"];
	}
	const names = new Map(competitors.map((competitor) => [competitor.entityId, competitor.name]));
	const findings: string[] = [];
	for (const cell of insights.cells) {
		const trend = insights.trends.find(
			(entry) => entry.platform === cell.platform && entry.surfaceMode === cell.surfaceMode,
		);
		findings.push(
			`${cellLabel(cell.platform, cell.surfaceMode)}：品牌提及率 ${counted(cell.mentionRate)}，推荐率 ${counted(
				cell.recommendationRate,
			)}${trend ? `；${trend.mention.label}` : ""}。`,
		);
		const ahead = cell.competitors.filter(
			(competitor) =>
				competitor.mentioned.status === "OK" &&
				cell.mentionRate.status === "OK" &&
				competitor.mentioned.rate > cell.mentionRate.rate,
		);
		if (ahead.length > 0) {
			findings.push(
				`${cellLabel(cell.platform, cell.surfaceMode)}：${ahead
					.map((competitor) => `${competitor.name}（${counted(competitor.mentioned)}）`)
					.join("、")} 的提及率高于本品牌。`,
			);
		}
	}
	const priorityGaps = insights.gaps.filter((gap) => gap.priority === "P0").slice(0, 5);
	for (const gap of priorityGaps) {
		const rivals = gap.competitorIds.map((id) => names.get(id) ?? id).join("、");
		findings.push(
			`P0 问法“${gap.questionText}”在${cellLabel(gap.platform, gap.surfaceMode)}最新一轮未稳定提及（${gap.mentioned}/${gap.evaluated}）${rivals ? `，回答中出现 ${rivals}` : ""}。`,
		);
	}
	const citations = insights.cells.reduce(
		(sum, cell) => ({
			total: sum.total + cell.citations.totalCitations,
			own: sum.own + cell.citations.byOwner.OWN,
		}),
		{ total: 0, own: 0 },
	);
	findings.push(
		citations.total === 0
			? "引用来源：本期回答未提供引用链接。"
			: `引用来源：共 ${citations.total} 条引用，其中自有品牌域名 ${citations.own} 条。`,
	);
	const errors = insights.cells.reduce((sum, cell) => sum + cell.errorRate.confirmedErrors, 0);
	const awaiting = insights.cells.reduce((sum, cell) => sum + cell.errorRate.awaitingTechReview, 0);
	findings.push(
		`事实准确性：经技术审核确认的错误描述 ${errors} 条，另有 ${awaiting} 条与已审核知识不一致的陈述待技术审核。`,
	);
	return findings;
}

export function buildRisks(input: {
	insights: Insights;
	targets: readonly ReportTarget[];
	openTasks: readonly ReportTask[];
	reviewPoolPending: number;
}): string[] {
	const risks: string[] = [];
	for (const cell of input.insights.cells) {
		if (cell.mentionRate.status === "NO_DATA") {
			risks.push(`${cellLabel(cell.platform, cell.surfaceMode)}：数据不足，本期无有效样本。`);
		} else if (cell.mentionRate.lowSample) {
			risks.push(
				`${cellLabel(cell.platform, cell.surfaceMode)}：有效样本 ${cell.mentionRate.denominator} 个，样本量低，变化仅供观察。`,
			);
		}
	}
	for (const target of input.targets) {
		if (target.verificationStatus !== "PASSED") {
			risks.push(
				`采样目标 ${cellLabel(target.platform, target.surfaceMode)}（${target.provider}）数据源验证状态为“${GEO_VERIFICATION_LABELS[target.verificationStatus]}”，结果不代表已全面支持该平台。`,
			);
		}
	}
	if (input.targets.some((target) => target.surfaceMode === "MODEL_API")) {
		risks.push("模型 API 代理评测的结果不等同于平台面向用户的产品回答。");
	}
	if (input.reviewPoolPending > 0) risks.push(`仍有 ${input.reviewPoolPending} 条评估在复核池中等待人工确认。`);
	if (input.openTasks.length > 0) risks.push(`仍有 ${input.openTasks.length} 个优化工单未完成。`);
	return risks;
}

export function defaultNextPlan(input: {
	promptSet: ReportSnapshot["conditions"]["promptSet"];
	openTasks: readonly ReportTask[];
	reviewPoolPending: number;
}): string[] {
	return [
		`继续使用${input.promptSet ? `问法集“${input.promptSet.name}” v${input.promptSet.version}` : "同一问法集版本"}，在相同平台与采样方式下按固定节奏复测，保持比较条件不变。`,
		input.reviewPoolPending > 0
			? `完成复核池中 ${input.reviewPoolPending} 条待确认评估。`
			: "复核池已清空，保持新样本的复核节奏。",
		input.openTasks.length > 0
			? `推进 ${input.openTasks.length} 个未完成工单，发布后关联复测批次，用至少两轮同向变化判断效果。`
			: "根据本期缺口创建新的优化工单。",
	];
}

export const BUSINESS_OUTCOME_NOTE =
	"本报告不衡量订单或销售结果：工作台没有接入官网线索、询盘或成交数据，任何业务结果都需要单独归因后才能引用。";

export function intermediateResults(insights: Insights): string[] {
	return insights.cells.map(
		(cell) =>
			`${cellLabel(cell.platform, cell.surfaceMode)}：提及 ${counted(cell.mentionRate)}；带引用的回答 ${counted(
				cell.citations.samplesWithCitations,
			)}；自有域名被引用 ${cell.citations.byOwner.OWN} 次。`,
	);
}

/** Every figure in the snapshot as rows, for a spreadsheet; built from the snapshot alone, so it reproduces exactly. */
export function reportCsv(snapshot: ReportSnapshot): string {
	const rows: (string | number | null)[][] = [["部分", "平台", "采样方式", "指标", "分子", "分母", "数值", "说明"]];
	const metricRow = (section: string, platform: GeoPlatform, mode: GeoSurfaceMode, name: string, value: MetricValue) =>
		rows.push([
			section,
			GEO_PLATFORM_LABELS[platform],
			GEO_SURFACE_MODE_LABELS[mode],
			name,
			value.status === "OK" ? value.numerator : null,
			value.status === "OK" ? value.denominator : null,
			formatMetric(value),
			value.status === "NO_DATA" ? value.reason : value.lowSample ? "样本量低" : "",
		]);
	for (const cell of snapshot.insights.cells) {
		metricRow("指标", cell.platform, cell.surfaceMode, "有效采样率", cell.validSampleRate.value);
		metricRow("指标", cell.platform, cell.surfaceMode, "品牌提及率", cell.mentionRate);
		metricRow("指标", cell.platform, cell.surfaceMode, "稳定提及问法率", cell.stableMention.value);
		metricRow("指标", cell.platform, cell.surfaceMode, "推荐率", cell.recommendationRate);
		metricRow("指标", cell.platform, cell.surfaceMode, "前三率", cell.top3Rate);
		metricRow("指标", cell.platform, cell.surfaceMode, "错误描述率", cell.errorRate.value);
		for (const competitor of cell.competitors) {
			metricRow("竞品覆盖", cell.platform, cell.surfaceMode, `${competitor.name} 提及率`, competitor.mentioned);
		}
		if (cell.citations.status === "NOT_PROVIDED") {
			rows.push([
				"引用来源",
				GEO_PLATFORM_LABELS[cell.platform],
				GEO_SURFACE_MODE_LABELS[cell.surfaceMode],
				"引用",
				null,
				null,
				"不提供",
				"回答未提供引用",
			]);
		}
		for (const domain of cell.citations.domains) {
			rows.push([
				"引用来源",
				GEO_PLATFORM_LABELS[cell.platform],
				GEO_SURFACE_MODE_LABELS[cell.surfaceMode],
				domain.host,
				domain.count,
				cell.citations.totalCitations,
				domain.owner,
				`${domain.samples} 个样本`,
			]);
		}
	}
	for (const finding of snapshot.findings) rows.push(["发现", null, null, null, null, null, null, finding]);
	for (const task of snapshot.tasks.executed) {
		rows.push(["已执行任务", null, null, task.title, null, null, task.state, task.publishedUrl ?? ""]);
	}
	for (const risk of snapshot.risks) rows.push(["未完成风险", null, null, null, null, null, null, risk]);
	for (const step of snapshot.nextPlan) rows.push(["下期计划", null, null, null, null, null, null, step]);
	return toCsv(rows);
}

/** The observation list filtered to exactly the samples one cell's figures were computed from. */
export function evidencePath(input: {
	organizationSlug: string;
	platform: GeoPlatform;
	surfaceMode: GeoSurfaceMode;
	promptSetId: string | null;
	from: string;
	to: string;
}): string {
	const params = new URLSearchParams({ platform: input.platform, surfaceMode: input.surfaceMode, status: "VALID" });
	if (input.promptSetId) params.set("promptSetId", input.promptSetId);
	params.set("from", input.from);
	params.set("to", input.to);
	return `/app/org/${encodeURIComponent(input.organizationSlug)}/geo/observations?${params.toString()}`;
}

export const GEO_REPORT_KINDS = ["MONTHLY", "ADHOC"] as const;
export type GeoReportKind = (typeof GEO_REPORT_KINDS)[number];

/** What `geo_generated_reports.filters` holds: everything needed to build the snapshot again. */
export interface ReportFilters {
	kind: GeoReportKind;
	periodLabel: string;
	promptSetId: string | null;
	notes: string | null;
	nextPlan: string[] | null;
}
