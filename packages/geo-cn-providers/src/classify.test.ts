import { describe, expect, it } from "vitest";
import { classifyHttpFailure, classifyThrown, failureRunStatus } from "./classify";
import { DEFAULT_RETRY_POLICY, decideRetry } from "./policy";

const none = new Headers();

describe("failure classification", () => {
	it("gives timeouts, captchas, rate limits and network errors their own statuses", () => {
		const timeout = classifyThrown(Object.assign(new Error("aborted"), { name: "TimeoutError" }));
		const network = classifyThrown(new TypeError("fetch failed", { cause: { code: "ECONNRESET" } }));
		const captcha = classifyHttpFailure(403, none, "<html>请完成安全验证 captcha</html>");
		const limited = classifyHttpFailure(429, new Headers({ "retry-after": "20" }), "{}");
		const forbidden = classifyHttpFailure(403, none, '{"error":{"code":"AccessDenied"}}');
		const unsupported = classifyHttpFailure(404, none, "");

		expect(failureRunStatus(timeout)).toBe("TIMEOUT");
		expect(failureRunStatus(network)).toBe("NETWORK_ERROR");
		expect(failureRunStatus(captcha)).toBe("CAPTCHA");
		expect(failureRunStatus(limited)).toBe("RATE_LIMITED");
		expect(limited.retryAfterMs).toBe(20_000);
		expect(failureRunStatus(forbidden)).toBe("UNAVAILABLE");
		expect(forbidden.code).toBe("FORBIDDEN");
		expect(failureRunStatus(unsupported)).toBe("UNAVAILABLE");
		expect(unsupported.code).toBe("UNSUPPORTED");
	});

	it("treats a content-safety refusal as unavailable, not as an answer without the brand", () => {
		const refused = classifyHttpFailure(400, none, '{"code":"data_inspection_failed","message":"..."}');
		expect(refused.kind).toBe("REFUSED");
		expect(failureRunStatus(refused)).toBe("UNAVAILABLE");
	});

	it("retries only transient failures", () => {
		const policy = { ...DEFAULT_RETRY_POLICY, maxAttempts: 3 };
		const random = () => 0;
		expect(decideRetry(classifyThrown(new TypeError("fetch failed")), 1, policy, random)).toMatchObject({
			retry: true,
		});
		expect(decideRetry(classifyHttpFailure(503, none, ""), 2, policy, random)).toMatchObject({ retry: true });
		expect(decideRetry(classifyHttpFailure(503, none, ""), 3, policy, random)).toEqual({
			retry: false,
			status: "FAILED",
		});
		expect(decideRetry(classifyHttpFailure(403, none, "captcha"), 1, policy, random)).toEqual({
			retry: false,
			status: "CAPTCHA",
		});
		expect(decideRetry(classifyHttpFailure(401, none, ""), 1, policy, random)).toEqual({
			retry: false,
			status: "UNAVAILABLE",
		});
	});

	it("never copies the response body into the failure message", () => {
		const body =
			'{"error":{"code":"invalid_api_key","message":"Incorrect API key provided: sk-abcdef1234567890abcdef"}}';
		const failure = classifyHttpFailure(401, none, body);
		expect(failure.message).not.toContain("sk-");
		expect(failure.message).toContain("invalid_api_key");
	});
});
