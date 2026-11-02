import { describe, expect, it } from "vitest";
import { sessionFactorFor } from "./session-factor";

const providers = new Set(["company-idp"]);

describe("what finishing a sign-in step proves", () => {
	it.each(["/two-factor/verify-totp", "/two-factor/verify-backup-code", "/two-factor/verify-otp"])(
		"counts %s as a second factor",
		(path) => {
			expect(sessionFactorFor(path, undefined, providers)).toBe("TWO_FACTOR");
		},
	);

	it("counts an SSO sign-in through the deployment's own provider", () => {
		expect(sessionFactorFor("/sso/callback/:providerId", "company-idp", providers)).toBe("SSO");
		expect(sessionFactorFor("/sso/saml2/sp/acs/:providerId", "company-idp", providers)).toBe("SSO");
	});

	it("does not count a provider someone registered over the API", () => {
		expect(sessionFactorFor("/sso/callback/:providerId", "registered-later", providers)).toBeNull();
	});

	it.each(["/callback/:id", "/sign-in/email", "/sign-in/social", "/two-factor/enable", "/sso/register"])(
		"does not count %s",
		(path) => {
			expect(sessionFactorFor(path, "company-idp", providers)).toBeNull();
		},
	);
});
