import { type CaptureFailure, captureFailure } from "./classify";
import { isHttpUrl } from "./http";
import type { CaptureCitation } from "./types";

export interface DoubaoAppAnswer {
	text: string;
	citations: CaptureCitation[];
	responseId?: string;
	model?: string;
	feature?: string;
	searchSummaries: string[];
	searchQueries: string[];
	/** Anything but a completed answer the service reports. */
	outcome: "complete" | "partial" | CaptureFailure;
}

const MAX_CITATIONS = 100;

function record(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function text(value: unknown, max: number): string | undefined {
	return typeof value === "string" && value.trim() ? value.slice(0, max) : undefined;
}

function isSearch(block: Record<string, unknown>): boolean {
	return block.type === "search" || block.type === "reasoning_search";
}

function searchCards(blocks: Record<string, unknown>[]): CaptureCitation[] {
	return blocks.filter(isSearch).flatMap((block) =>
		(Array.isArray(block.results) ? block.results : []).flatMap((result) => {
			const card = record(record(result)?.text_card);
			if (!isHttpUrl(card?.url)) return [];
			const title = text(card.title, 500)?.trim();
			return [title ? { url: card.url, title } : { url: card.url }];
		}),
	);
}

function searchCitations(blocks: Record<string, unknown>[]): CaptureCitation[] {
	const seen = new Set<string>();
	return searchCards(blocks)
		.filter((citation) => !seen.has(citation.url) && Boolean(seen.add(citation.url)))
		.slice(0, MAX_CITATIONS);
}

function reportedOutcome(body: Record<string, unknown>): DoubaoAppAnswer["outcome"] {
	const error = record(body.error);
	if (error) {
		return captureFailure("UPSTREAM", "PROVIDER_ERROR", `豆包助手返回错误 ${text(error.code, 64) ?? "UNKNOWN"}`);
	}
	if (body.status === "failed") return captureFailure("UPSTREAM", "PROVIDER_FAILED", "豆包助手报告回答失败");
	if (body.status === "incomplete") return "partial";
	return "complete";
}

/**
 * Reads a non-streaming Ark Responses API body produced with the `doubao_app` tool: the
 * answer is every `output_text` block in order, and the sources are the cards of every
 * search block, which is what the Doubao app lists under an answer.
 */
export function readDoubaoAppResponse(body: unknown): DoubaoAppAnswer {
	const root = record(body) ?? {};
	const calls = (Array.isArray(root.output) ? root.output : [])
		.map(record)
		.filter((item): item is Record<string, unknown> => item?.type === "doubao_app_call");
	const blocks = calls.flatMap((call) =>
		(Array.isArray(call.blocks) ? call.blocks : [])
			.map(record)
			.filter((block): block is Record<string, unknown> => block !== null),
	);
	const searches = blocks.filter(isSearch);
	return {
		text: blocks
			.filter((block) => block.type === "output_text")
			.map((block) => (typeof block.text === "string" ? block.text : ""))
			.join("\n\n")
			.trim(),
		citations: searchCitations(blocks),
		responseId: text(root.id, 200),
		model: text(root.model, 200),
		feature: text(calls[0]?.feature, 64),
		searchSummaries: searches.flatMap((block) => text(block.summary, 200) ?? []),
		searchQueries: searches
			.flatMap((block) => (Array.isArray(block.queries) ? block.queries : []))
			.flatMap((query) => text(query, 200) ?? [])
			.slice(0, 20),
		outcome: reportedOutcome(root),
	};
}
