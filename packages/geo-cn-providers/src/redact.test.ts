import { describe, expect, it } from "vitest";
import { describeText, redactForLog, redactSecrets, safeErrorDetail } from "./redact";

const KEY = "sk-live-0123456789abcdefABCDEF";

describe("redaction", () => {
	it("removes a known credential wherever it appears", () => {
		expect(redactSecrets(`request failed with key ${KEY} at host`, [KEY])).not.toContain(KEY);
	});

	it("removes credential-shaped values it was not told about", () => {
		const text = [
			"Authorization: Bearer abcdefghijklmnop123456",
			"https://api.example-ai.test/v1?api_key=topsecretvalue&x=1",
			'{"apiKey":"hunter2hunter2"}',
			"sk-0123456789abcdefghijkl",
		].join("\n");
		const result = redactSecrets(text);
		expect(result).not.toMatch(/abcdefghijklmnop123456|topsecretvalue|hunter2hunter2|sk-0123456789abcdefghijkl/);
		expect(result).toContain("x=1");
	});

	it("reduces questions and answers to a length and a hash in log payloads", () => {
		const question = "华南地区高低压开关柜供应商怎么比较？";
		const answer = "示例电气是一家……";
		const logged = JSON.stringify(
			redactForLog(
				{ prompt: question, response: { text: answer }, headers: { authorization: `Bearer ${KEY}` }, status: 500 },
				{ secrets: [KEY] },
			),
		);
		expect(logged).not.toContain(question);
		expect(logged).not.toContain(answer);
		expect(logged).not.toContain(KEY);
		expect(logged).toContain("500");
		expect(describeText(question)).toMatch(/^\[已隐藏文本 \d+ 字 sha256:[0-9a-f]{12}\]$/);
	});

	it("keeps error details free of credentials and of the question asked", () => {
		const question = "示例电气的 KYN28 柜型参数是多少";
		const error = new Error(`upstream echoed "${question}" with token ${KEY}`);
		const detail = safeErrorDetail(error, { secrets: [KEY], sensitiveTexts: [question] });
		expect(detail).not.toContain(KEY);
		expect(detail).not.toContain(question);
	});
});
