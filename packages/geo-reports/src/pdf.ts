import { existsSync } from "node:fs";
import {
	GEO_CITATION_OWNER_LABELS,
	GEO_PLATFORM_LABELS,
	GEO_SURFACE_MODE_LABELS,
	GEO_TASK_STATE_LABELS,
} from "@workspace/geo-domain";
import PDFDocument from "pdfkit";
import { type CellMetrics, type EqualWeightSummary, formatMetric, formatSummaryRate, type MetricValue } from "./metrics";
import { cellLabel, type ReportSnapshot } from "./report";

export class GeoPdfFontError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GeoPdfFontError";
	}
}

export interface CjkFont {
	path: string;
	/** Face name inside a font collection (.ttc); unused for a single font file. */
	family?: string;
}

const DEFAULT_FONT_PATHS = [
	"/usr/share/fonts/noto/NotoSansCJK-Regular.ttc",
	"/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
	"/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc",
	"/usr/share/fonts/google-noto-cjk/NotoSansCJK-Regular.ttc",
];
const DEFAULT_COLLECTION_FACE = "NotoSansCJKsc-Regular";

/**
 * `GEO_PDF_FONT_PATH` may name a face inside a collection as `path#Face`. Without a
 * usable CJK font there must be no PDF at all, rather than one with boxes in place of Chinese.
 */
export function resolveCjkFont(env: Record<string, string | undefined> = process.env): CjkFont {
	const configured = env.GEO_PDF_FONT_PATH?.trim();
	const candidates = configured ? [configured] : DEFAULT_FONT_PATHS;
	for (const candidate of candidates) {
		const [path = "", face] = candidate.split("#");
		if (!existsSync(path)) continue;
		const family = face || (path.toLowerCase().endsWith(".ttc") ? DEFAULT_COLLECTION_FACE : undefined);
		return { path, family };
	}
	throw new GeoPdfFontError(
		configured
			? `GEO_PDF_FONT_PATH 指向的字体文件不存在：${configured}`
			: "未找到中文字体，请安装 Noto CJK 或设置 GEO_PDF_FONT_PATH",
	);
}

interface FontkitFace {
	hasGlyphForCodePoint?: (codePoint: number) => boolean;
}

function assertCoversChinese(doc: PDFKit.PDFDocument): void {
	const face = (doc as unknown as { _font?: { font?: FontkitFace } })._font?.font;
	if (face?.hasGlyphForCodePoint && !face.hasGlyphForCodePoint("中".codePointAt(0) ?? 0)) {
		throw new GeoPdfFontError("配置的字体不包含中文字形，无法生成报告 PDF");
	}
}

function rate(value: MetricValue): string {
	if (value.status === "NO_DATA") return "数据不足";
	return `${formatMetric(value)}（${value.numerator}/${value.denominator}）${value.lowSample ? " 样本量低" : ""}`;
}

class Writer {
	constructor(readonly doc: PDFKit.PDFDocument) {}

	heading(text: string) {
		this.doc.moveDown(0.8).fontSize(13).fillColor("#111111").text(text).moveDown(0.3).fontSize(10).fillColor("#333333");
	}

	paragraph(text: string) {
		this.doc.text(text, { lineGap: 2 });
	}

	bullets(items: readonly string[]) {
		if (items.length === 0) this.paragraph("无。");
		for (const item of items) this.paragraph(`• ${item}`);
	}
}

function writeHeader(out: Writer, snapshot: ReportSnapshot) {
	const { promptSet, evaluatorVersions } = snapshot.conditions;
	out.doc.fontSize(18).fillColor("#111111").text(snapshot.title);
	out.doc
		.moveDown(0.3)
		.fontSize(10)
		.fillColor("#555555")
		.text(`统计周期：${snapshot.period.label}（北京时间）  生成时间：${snapshot.generatedAt}`)
		.text(
			`问法集：${promptSet ? `${promptSet.name} v${promptSet.version}` : "未限定"}  指标口径：${snapshot.metricVersion}  评估规则：${evaluatorVersions.join("、") || "—"}`,
		);
}

function writeSample(out: Writer, snapshot: ReportSnapshot) {
	const totals = snapshot.insights.totals;
	out.heading("二、样本");
	out.paragraph(
		`计划采样 ${totals.planned} 次，有效样本 ${totals.valid} 个，已评估 ${totals.evaluated} 个，待评估 ${totals.pendingEvaluation} 个。`,
	);
	for (const cell of snapshot.insights.cells) {
		const b = cell.validSampleRate.breakdown;
		out.paragraph(
			`${cellLabel(cell.platform, cell.surfaceMode)}：有效采样率 ${rate(cell.validSampleRate.value)}；拒绝/不可用 ${b.refused}，限流 ${b.rateLimited}，失败 ${b.failed}，截断 ${b.partial}，进行中 ${b.pending}。`,
		);
	}
	if (snapshot.insights.noData) {
		out.paragraph("所有平台均无有效样本：本期不显示任何比率（数据不足），失败样本不计为“未提及”。");
	}
}

function citationLine(cell: CellMetrics): string {
	if (cell.citations.status === "NOT_PROVIDED") return "引用来源：不提供";
	const top = cell.citations.domains
		.slice(0, 5)
		.map((domain) => `${domain.host}（${GEO_CITATION_OWNER_LABELS[domain.owner]}，${domain.count}）`);
	return `引用来源：${top.join("；")}`;
}

function writeMetrics(out: Writer, snapshot: ReportSnapshot) {
	out.heading("三、指标（按平台与采样方式分开）");
	for (const cell of snapshot.insights.cells) {
		out.doc.fillColor("#111111").text(cellLabel(cell.platform, cell.surfaceMode)).fillColor("#333333");
		const competitors = cell.competitors.map((competitor) => `${competitor.name} ${rate(competitor.mentioned)}`);
		out.bullets([
			`品牌提及率：${rate(cell.mentionRate)}`,
			`稳定提及问法率：${rate(cell.stableMention.value)}；样本不足的问法 ${cell.stableMention.insufficientUnits} 个`,
			`推荐率：${rate(cell.recommendationRate)}；待复核的推荐 ${cell.recommendationsAwaitingReview} 条`,
			`前三率：${rate(cell.top3Rate)}`,
			`竞品覆盖：${competitors.join("；") || "未配置竞品"}`,
			citationLine(cell),
			`错误描述率：${rate(cell.errorRate.value)}；待技术审核 ${cell.errorRate.awaitingTechReview} 条`,
		]);
	}
	const summary = (entry: EqualWeightSummary) =>
		`${formatSummaryRate(entry.value)}${entry.value.status === "OK" && entry.value.lowSample ? " 样本量低" : ""}（${entry.cellsIncluded} 个平台）`;
	for (const mode of snapshot.insights.overview.bySurfaceMode) {
		out.paragraph(
			`${GEO_SURFACE_MODE_LABELS[mode.surfaceMode]}内部概览（等权）：品牌提及率 ${summary(mode.mention)}；推荐率 ${summary(mode.recommendation)}。${mode.mention.note}`,
		);
	}
	const mixed = snapshot.insights.overview.crossMode;
	if (mixed) {
		out.paragraph(
			`跨采样方式汇总（按要求附加）：品牌提及率 ${summary(mixed.mention)}；推荐率 ${summary(mixed.recommendation)}。${mixed.mention.note}`,
		);
	}
	out.heading("四、趋势");
	for (const trend of snapshot.insights.trends) {
		const breaks = trend.points.filter((point) => point.breakpoint.length > 0).length;
		out.paragraph(
			`${cellLabel(trend.platform, trend.surfaceMode)}：${trend.points.length} 轮；提及 ${trend.mention.label}；推荐 ${trend.recommendation.label}${breaks > 0 ? `；有 ${breaks} 处比较条件断点` : ""}。`,
		);
	}
}

function writeOutcomes(out: Writer, snapshot: ReportSnapshot, baseUrl: string | undefined) {
	out.heading("五、发现");
	out.bullets(snapshot.findings);
	out.heading("六、已执行任务");
	out.bullets(
		snapshot.tasks.executed.map(
			(task) =>
				`${task.title}（${GEO_TASK_STATE_LABELS[task.state]}）${task.publishedUrl ? ` ${task.publishedUrl}` : ""}`,
		),
	);
	const inputs = snapshot.businessInputs;
	out.heading("七、投入、中间结果与业务结果");
	out.bullets([
		`已核验资料：已审核事实 ${inputs.approvedAssertions} 条，其中本期新审核 ${inputs.approvedInPeriod} 条。`,
		`已发布内容：本期登记发布 ${inputs.publishedContentInPeriod} 篇内容，${inputs.tasksPublishedInPeriod} 个工单登记发布。`,
		...snapshot.intermediateResults,
		...snapshot.businessOutcomes,
	]);
	out.heading("八、未完成风险");
	out.bullets(snapshot.risks);
	out.heading("九、下期计划");
	out.bullets(snapshot.nextPlan);
	if (snapshot.notes) {
		out.heading("补充说明");
		out.paragraph(snapshot.notes);
	}
	out.heading("证据链接");
	const prefix = baseUrl ? baseUrl.replace(/\/$/, "") : "";
	for (const link of snapshot.evidenceLinks) {
		out.paragraph(
			`${GEO_PLATFORM_LABELS[link.platform]} · ${GEO_SURFACE_MODE_LABELS[link.surfaceMode]}：${prefix}${link.path}`,
		);
	}
}

function loadFont(doc: PDFKit.PDFDocument, font: CjkFont) {
	try {
		if (font.family) doc.registerFont("cjk", font.path, font.family);
		else doc.registerFont("cjk", font.path);
		doc.font("cjk");
	} catch (error) {
		throw new GeoPdfFontError(`无法加载中文字体：${error instanceof Error ? error.message : String(error)}`);
	}
	assertCoversChinese(doc);
}

/** Renders a stored snapshot only, so a past month's PDF can be rebuilt from it with the same content. */
export async function renderReportPdf(
	snapshot: ReportSnapshot,
	font: CjkFont,
	options: { baseUrl?: string } = {},
): Promise<Uint8Array> {
	const doc = new PDFDocument({ size: "A4", margin: 48, info: { Title: snapshot.title, Creator: "Elmo GEO" } });
	loadFont(doc, font);
	const chunks: Buffer[] = [];
	const done = new Promise<Uint8Array>((resolve, reject) => {
		doc.on("data", (chunk: Buffer) => chunks.push(chunk));
		doc.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
		doc.on("error", reject);
	});
	const out = new Writer(doc);
	writeHeader(out, snapshot);
	out.heading("一、方法与口径");
	out.bullets(snapshot.methodology);
	writeSample(out, snapshot);
	writeMetrics(out, snapshot);
	writeOutcomes(out, snapshot, options.baseUrl);
	doc.end();
	return done;
}
