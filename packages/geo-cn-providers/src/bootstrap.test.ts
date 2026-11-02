import { describe, expect, it } from "vitest";
import { parseBootstrapTargets } from "./bootstrap";

describe("bootstrap targets", () => {
	it("never takes a verification status from the file", () => {
		const { targets, errors } = parseBootstrapTargets([
			{
				key: "deepseek-api",
				platform: "deepseek",
				surfaceMode: "MODEL_API",
				provider: "openai-compatible",
				verificationStatus: "PASSED",
				enabled: false,
			},
		]);
		expect(errors).toEqual([]);
		expect(targets[0]).not.toHaveProperty("verificationStatus");
		expect(targets[0].enabled).toBe(false);
	});

	it("refuses a credential written into the file", () => {
		const { targets, errors } = parseBootstrapTargets([
			{
				key: "k",
				platform: "qwen",
				surfaceMode: "MODEL_API",
				provider: "p",
				config: { baseUrl: "https://x.test", apiKey: "abc" },
			},
			{ key: "k2", platform: "qwen", surfaceMode: "MODEL_API", provider: "p", credentialRef: "plain-key-value" },
		]);
		expect(targets).toEqual([]);
		expect(errors).toHaveLength(2);
	});
});
