import { describe, expect, it } from "vitest";
import { ModelApiAdapter } from "./model-api";
import type { CaptureRequest, FetchLike } from "./types";

const KEY = "sk-test-0123456789abcdef0123";
const request: CaptureRequest = {
	promptId: "p1",
	promptText: "高低压开关柜选型要看哪些参数",
	targetId: "t1",
	mode: "MODEL_API",
	runId: "r1",
	idempotencyKey: "b:p:t:0",
};

function adapter(fetchImpl: FetchLike) {
	return new ModelApiAdapter({
		config: {
			baseUrl: "https://api.example-ai.test/v1",
			model: "example-chat",
			pricing: { inputPer1k: 1, outputPer1k: 2 },
		},
		credential: KEY,
		fetch: fetchImpl,
		timeoutMs: 5000,
		now: () => new Date("2026-11-03T00:00:00Z"),
	});
}

describe("model API adapter", () => {
	it("keeps the answer, citations and cost, and labels the result as a proxy evaluation", async () => {
		const result = await adapter(async (_url, init) => {
			expect((init?.headers as Record<string, string> | undefined)?.Authorization).toBe(`Bearer ${KEY}`);
			return Response.json({
				id: "cmpl-1",
				model: "example-chat-2026",
				choices: [{ message: { content: "可参考示例电气……" }, finish_reason: "stop" }],
				usage: { prompt_tokens: 1000, completion_tokens: 500 },
				citations: ["https://www.example-electric.test/p", "not a url"],
			});
		}).capture(request);
		expect(result).toMatchObject({
			status: "VALID",
			surfaceMode: "MODEL_API",
			modelVersion: "example-chat-2026",
			providerTraceId: "cmpl-1",
			costEstimate: 2,
			citations: [{ url: "https://www.example-electric.test/p" }],
		});
		expect(result.responseMetadata?.proxyEvaluation).toBe(true);
	});

	it("marks a truncated answer as partial", async () => {
		const result = await adapter(async () =>
			Response.json({ choices: [{ message: { content: "部分" }, finish_reason: "length" }] }),
		).capture(request);
		expect(result.status).toBe("PARTIAL");
	});

	it("reports a rate limit without echoing the credential or the question", async () => {
		const result = await adapter(
			async () =>
				new Response(`{"error":{"code":"rate_limit","message":"key ${KEY} asked ${request.promptText}"}}`, {
					status: 429,
				}),
		).capture(request);
		expect(result.failure).toMatchObject({ kind: "RATE_LIMITED", retryable: true });
		expect(JSON.stringify(result)).not.toContain(KEY);
		expect(JSON.stringify(result)).not.toContain(request.promptText);
	});

	it("turns an empty answer into a failure rather than an answer without the brand", async () => {
		const result = await adapter(async () =>
			Response.json({ choices: [{ message: { content: "  " }, finish_reason: "stop" }] }),
		).capture(request);
		expect(result.status).toBe("FAILED");
		expect(result.responseText).toBeUndefined();
	});
});
