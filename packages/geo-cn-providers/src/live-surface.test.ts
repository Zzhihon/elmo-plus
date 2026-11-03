import { describe, expect, it } from "vitest";
import { failureRunStatus } from "./classify";
import { parseLiveSurfaceConfig } from "./config";
import { LicensedHttpAdapter } from "./live-surface";

const parsed = parseLiveSurfaceConfig({
	serviceName: "示例采样服务",
	licenseNote: "合同编号见采购档案",
	endpoint: "https://capture.example-vendor.test/v1/answers",
	auth: { type: "bearer" },
	request: { app: "{{platform}}", query: "{{prompt}}" },
	response: {
		text: "data.answer",
		citations: "data.refs",
		status: "data.state",
		statusMap: { captcha: ["NEED_VERIFY"] },
	},
});

function adapter(body: unknown) {
	if (!parsed.ok) throw new Error(parsed.errors.join(","));
	return new LicensedHttpAdapter({
		config: parsed.value,
		credential: "vendor-key-123456",
		platform: "doubao",
		timeoutMs: 5000,
		fetch: async (_url, init) => {
			expect(JSON.parse(String(init?.body))).toEqual({ app: "doubao", query: "问题" });
			return Response.json(body);
		},
	});
}

const request = {
	promptId: "p",
	promptText: "问题",
	targetId: "t",
	mode: "LIVE_SURFACE" as const,
	runId: "r",
	idempotencyKey: "k",
};

describe("licensed live-surface adapter", () => {
	it("maps the configured fields into a capture", async () => {
		const result = await adapter({
			data: { answer: "回答", refs: [{ url: "https://a.example.test" }], state: "OK" },
		}).capture(request);
		expect(result).toMatchObject({
			status: "VALID",
			responseText: "回答",
			citations: [{ url: "https://a.example.test" }],
		});
		expect(result.responseMetadata).toMatchObject({ proxyEvaluation: false, serviceName: "示例采样服务" });
	});

	it("turns a vendor-reported captcha into a manual case instead of an answer", async () => {
		const result = await adapter({ data: { state: "NEED_VERIFY" } }).capture(request);
		expect(result.failure && failureRunStatus(result.failure)).toBe("CAPTCHA");
		expect(result.failure?.retryable).toBe(false);
	});
});

describe("Doubao assistant responses", () => {
	const doubaoConfig = {
		serviceName: "豆包助手 API",
		licenseNote: "平台官方接口",
		endpoint: "https://ark.example-cloud.test/api/v3/responses",
		auth: { type: "bearer" },
		headers: { "ark-beta-doubao-app": "true" },
		responseFormat: "doubao-app",
		request: {
			model: "assistant-model",
			stream: false,
			tools: [{ type: "doubao_app", feature: { ai_search: { type: "enabled" } } }],
			input: [{ role: "user", content: [{ type: "input_text", text: "{{prompt}}" }] }],
		},
	};
	const doubao = parseLiveSurfaceConfig(doubaoConfig);

	function doubaoAdapter(body: unknown) {
		if (!doubao.ok) throw new Error(doubao.errors.join(","));
		return new LicensedHttpAdapter({
			config: doubao.value,
			credential: "vendor-key-123456",
			platform: "doubao",
			timeoutMs: 5000,
			fetch: async () => Response.json(body),
		});
	}

	const search = (urls: string[]) => ({
		type: "search",
		summary: "搜索 1 个关键词",
		queries: ["关键词"],
		results: urls.map((url) => ({ text_card: { title: `标题 ${url}`, url } })),
	});

	it("takes the answer from the text blocks and the sources from every search", async () => {
		const result = await doubaoAdapter({
			id: "resp_1",
			model: "assistant-model-v2",
			status: "completed",
			output: [
				{
					type: "doubao_app_call",
					feature: "ai_search",
					blocks: [
						search(["https://a.example.test/", "https://b.example.test/"]),
						{ type: "output_text", text: "第一段" },
						search(["https://a.example.test/", "https://c.example.test/"]),
						{ type: "output_text", text: "第二段" },
					],
				},
			],
		}).capture(request);
		expect(result).toMatchObject({
			status: "VALID",
			surfaceMode: "LIVE_SURFACE",
			responseText: "第一段\n\n第二段",
			modelVersion: "assistant-model-v2",
			providerTraceId: "resp_1",
		});
		expect(result.citations?.map((citation) => citation.url)).toEqual([
			"https://a.example.test/",
			"https://b.example.test/",
			"https://c.example.test/",
		]);
		expect(result.responseMetadata).toMatchObject({ proxyEvaluation: false, doubaoAppFeature: "ai_search" });
	});

	it("keeps an answer the service cut short, marked partial", async () => {
		const result = await doubaoAdapter({
			status: "incomplete",
			output: [{ type: "doubao_app_call", blocks: [{ type: "output_text", text: "半截" }] }],
		}).capture(request);
		expect(result).toMatchObject({ status: "PARTIAL", responseText: "半截" });
	});

	it("fails a reply that holds no answer text", async () => {
		const result = await doubaoAdapter({
			status: "completed",
			output: [{ type: "doubao_app_call", blocks: [search(["https://a.example.test/"])] }],
		}).capture(request);
		expect(result.status).toBe("FAILED");
		expect(result.errorCode).toBe("EMPTY_RESPONSE");
	});

	it("refuses an unknown response format", () => {
		expect(parseLiveSurfaceConfig({ ...doubaoConfig, responseFormat: "html" }).ok).toBe(false);
	});
});
