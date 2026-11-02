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
