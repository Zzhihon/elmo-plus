import type { GeoDictionarySnapshot } from "@workspace/geo-domain";

function namesOf(snapshot: GeoDictionarySnapshot, kind: "OWN" | "COMPETITOR"): string {
	return snapshot.entities
		.filter((entity) => entity.kind === kind && entity.status === "ACTIVE")
		.map((entity) => [entity.displayName, entity.shortName, ...entity.aliases].filter(Boolean).join(" / "))
		.join("；");
}

/**
 * The single structured completion the semantic layer asks for. Only the question, the
 * captured answer and the dictionary names go out; nothing from the knowledge base does.
 */
export function buildSemanticPrompt(input: {
	question: string;
	answer: string;
	dictionary: GeoDictionarySnapshot;
}): string {
	return [
		"你是 B2B 采购问答的评估员。根据下面一条 AI 回答，判断它如何对待“本品牌”。只依据回答原文，不要使用外部知识。",
		"",
		`本品牌名称（任一名称出现即视为提及）：${namesOf(input.dictionary, "OWN") || "（无）"}`,
		`竞品名称：${namesOf(input.dictionary, "COMPETITOR") || "（无）"}`,
		"",
		"判定口径：",
		"- RECOMMENDED：回答明确正向推荐本品牌（推荐、首选、建议选择，或把它列入推荐清单）。",
		"- MENTIONED_ONLY：提到本品牌，但没有明确推荐，也没有负面警示（仅列举、对比、引用不算推荐）。",
		"- NEGATIVE：对本品牌给出负面评价或警示（不推荐、谨慎、投诉、质量问题等）。",
		"- NOT_MENTIONED：完全没有提到本品牌。",
		"- hasOrderedList：回答是否包含给厂商或品牌排序的编号清单；没有排序时为 false，不要推测名次。",
		"- brandRank：本品牌在该清单中的位置（从 1 开始），不在清单中或没有清单时为 null。",
		"- evidenceQuote：逐字摘录支持你结论的原文片段（不超过 120 字），找不到时为 null。",
		"- confidence：0 到 1 之间，表示你对结论的把握。",
		"",
		`问题：${input.question}`,
		"",
		"回答原文：",
		input.answer,
	].join("\n");
}
