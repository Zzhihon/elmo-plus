import type { GeoContentKind } from "@workspace/geo-domain";
import type { PublicSource } from "./knowledge-core";
import type { KnowledgeValue } from "./knowledge-shared";

export interface DraftClaim {
	ref: string;
	assertionId: string;
	entityTitle: string | null;
	claimType: string;
	fieldPath: string | null;
	claimText: string;
	normalizedValue: KnowledgeValue;
	riskLevel: "HIGH" | "NORMAL";
	validUntil: string | null;
	sources: PublicSource[];
}

export const CONTENT_KIND_LABELS: Record<GeoContentKind, string> = {
	FAQ: "产品 FAQ",
	SELECTION_GUIDE: "选型指南",
	CASE: "项目案例",
	COMPANY_INTRO: "企业介绍",
};

const KIND_GUIDANCE: Record<GeoContentKind, string> = {
	FAQ: "以问答形式组织：每个问题用 “### ” 开头，下面是回答。问题应是采购或技术人员真实会问的问题。",
	SELECTION_GUIDE: "按选型要点分节（用 “## ” 开头），说明适用场景、关键参数和选择依据。",
	CASE: "按项目背景、采用的产品与方案、交付结果组织；交付结果只能来自事实清单。",
	COMPANY_INTRO: "介绍企业概况、主营产品、资质与服务，语气客观，不使用最高级或无法核实的宣传用语。",
};

const MARKER = /\[(F\d+(?:\s*[,，、]\s*F\d+)*)\]/g;

function valueText(value: unknown): string {
	if (value === null || value === undefined) return "";
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.map(valueText).join("；");
	return JSON.stringify(value);
}

/** Everything the model sees: reviewed public facts, numbered. No documents, no sources, no internal notes. */
export function buildDraftPrompt(input: {
	kind: GeoContentKind;
	title: string;
	instructions: string | null;
	claims: readonly DraftClaim[];
}): string {
	const facts = input.claims
		.map((claim) => {
			const value = valueText(claim.normalizedValue);
			const detail = value && value !== claim.claimText ? `（取值：${value}）` : "";
			return `[${claim.ref}] ${claim.entityTitle ? `${claim.entityTitle}：` : ""}${claim.claimText}${detail}`;
		})
		.join("\n");
	return [
		`请撰写一篇简体中文的${CONTENT_KIND_LABELS[input.kind]}草稿，主题：${input.title}。`,
		KIND_GUIDANCE[input.kind],
		"",
		"必须遵守：",
		"1. 只能使用下面“已审核事实”中的信息。不得写出事实清单以外的任何数字、型号、标准号、证书、资质、专利、客户名称或项目结果。",
		"2. 每个包含事实的句子，在句末用方括号标注所依据的事实编号，例如 [F1] 或 [F1, F3]。不得引用不存在的编号。",
		"3. 不确定的内容宁可不写；不要使用“最”“第一”“领先”等无法核实的表述。",
		"4. 正文使用 Markdown，不要包含 HTML，不要输出事实清单本身。",
		input.instructions ? `\n补充要求（不得违反以上规则）：${input.instructions}` : "",
		"",
		"已审核事实：",
		facts,
	].join("\n");
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function citationOrder(body: string, claims: readonly DraftClaim[]): Map<string, number> {
	const known = new Set(claims.map((claim) => claim.ref));
	const order = new Map<string, number>();
	for (const match of body.matchAll(MARKER)) {
		for (const ref of match[1].split(/\s*[,，、]\s*/)) {
			if (known.has(ref) && !order.has(ref)) order.set(ref, order.size + 1);
		}
	}
	return order;
}

function sourceLine(source: PublicSource): string {
	if (source.kind === "PAGE_VERSION") return source.url;
	return `客户资料《${source.title ?? "未命名"}》${source.page ? `第 ${source.page} 页` : ""}`;
}

const UNSAFE_INLINE_LINK = /\]\(\s*(?!https?:\/\/|mailto:|#)[^)]*\)/gi;
const UNSAFE_REFERENCE_LINK = /^(\s*\[(?!\^)[^\]]+\]:\s*)(?!https?:\/\/|mailto:)\S.*$/gim;

/**
 * The file is pasted into a CMS that may render HTML, so markup stays visible as
 * text and a link can only lead to the web or a mailbox.
 */
function neutralizeMarkdown(text: string): string {
	return text.replace(/</g, "&lt;").replace(UNSAFE_INLINE_LINK, "]").replace(UNSAFE_REFERENCE_LINK, "$1");
}

/** Markdown with numbered footnotes; each footnote names the fact and where it can be checked. */
export function renderDraftMarkdown(input: { title: string; body: string; claims: readonly DraftClaim[] }): string {
	const order = citationOrder(input.body, input.claims);
	const body = input.body.replace(MARKER, (_, refs: string) =>
		refs
			.split(/\s*[,，、]\s*/)
			.map((ref) => order.get(ref))
			.filter((number): number is number => number !== undefined)
			.map((number) => `[^${number}]`)
			.join(""),
	);
	const notes = input.claims
		.filter((claim) => order.has(claim.ref))
		.sort((a, b) => (order.get(a.ref) ?? 0) - (order.get(b.ref) ?? 0))
		.map((claim) => {
			const sources = claim.sources.map(sourceLine).join("；") || "已审核事实";
			return `[^${order.get(claim.ref)}]: ${claim.claimText}。来源：${sources}`;
		});
	return neutralizeMarkdown([`# ${input.title}`, "", body.trim(), "", ...notes, ""].join("\n"));
}

function inline(text: string, order: Map<string, number>): string {
	const parts: string[] = [];
	let last = 0;
	for (const match of text.matchAll(MARKER)) {
		parts.push(escapeHtml(text.slice(last, match.index)).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>"));
		for (const ref of match[1].split(/\s*[,，、]\s*/)) {
			const number = order.get(ref);
			if (number) parts.push(`<sup><a href="#source-${number}">[${number}]</a></sup>`);
		}
		last = (match.index ?? 0) + match[0].length;
	}
	parts.push(escapeHtml(text.slice(last)).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>"));
	return parts.join("");
}

interface Line {
	type: "h" | "ul" | "ol" | "p" | "blank";
	text: string;
	level: number;
}

function classify(raw: string): Line {
	const line = raw.trim();
	const heading = /^(#{1,4})\s+(.*)$/.exec(line);
	if (heading) return { type: "h", text: heading[2], level: Math.min(heading[1].length + 1, 5) };
	const bullet = /^[-*+]\s+(.*)$/.exec(line);
	if (bullet) return { type: "ul", text: bullet[1], level: 0 };
	const numbered = /^\d+[.)、]\s+(.*)$/.exec(line);
	if (numbered) return { type: "ol", text: numbered[1], level: 0 };
	return { type: line ? "p" : "blank", text: line, level: 0 };
}

function renderGroup(group: Line[], order: Map<string, number>): string {
	const [first] = group;
	switch (first.type) {
		case "blank":
			return "";
		case "h":
			return `<h${first.level}>${inline(first.text, order)}</h${first.level}>`;
		case "ul":
		case "ol":
			return `<${first.type}>${group.map((line) => `<li>${inline(line.text, order)}</li>`).join("")}</${first.type}>`;
		case "p":
			return `<p>${inline(group.map((line) => line.text).join(" "), order)}</p>`;
	}
}

/** Consecutive lines of one kind form one block; a heading always stands alone. */
function renderBlocks(body: string, order: Map<string, number>): string[] {
	const lines = body.split("\n").map(classify);
	const html: string[] = [];
	let start = 0;
	while (start < lines.length) {
		const type = lines[start].type;
		let end = start + 1;
		if (type !== "h") while (end < lines.length && lines[end].type === type) end++;
		const block = renderGroup(lines.slice(start, end), order);
		if (block) html.push(block);
		start = end;
	}
	return html;
}

function renderNotes(claims: readonly DraftClaim[], order: Map<string, number>): string[] {
	return claims
		.filter((claim) => order.has(claim.ref))
		.sort((a, b) => (order.get(a.ref) ?? 0) - (order.get(b.ref) ?? 0))
		.map((claim) => {
			const sources = claim.sources
				.map((source) =>
					source.kind === "PAGE_VERSION" && /^https?:\/\//.test(source.url)
						? `<a href="${escapeHtml(source.url)}" rel="nofollow noopener">${escapeHtml(source.url)}</a>`
						: escapeHtml(sourceLine(source)),
				)
				.join("；");
			return `<li id="source-${order.get(claim.ref)}">${escapeHtml(claim.claimText)}。来源：${sources || "已审核事实"}</li>`;
		});
}

/**
 * A self-contained page for the publisher to paste. Only headings, paragraphs,
 * lists and bold survive; every character of the body is escaped first.
 */
export function renderDraftHtml(input: { title: string; body: string; claims: readonly DraftClaim[] }): string {
	const order = citationOrder(input.body, input.claims);
	const notes = renderNotes(input.claims, order);
	return [
		"<!DOCTYPE html>",
		'<html lang="zh-CN">',
		'<head><meta charset="utf-8">',
		`<title>${escapeHtml(input.title)}</title></head>`,
		"<body>",
		`<h1>${escapeHtml(input.title)}</h1>`,
		...renderBlocks(input.body, order),
		notes.length > 0 ? `<h2>来源</h2>\n<ol>\n${notes.join("\n")}\n</ol>` : "",
		"</body>",
		"</html>",
		"",
	].join("\n");
}
