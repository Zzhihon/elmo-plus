import { describe, expect, it } from "vitest";
import type { GeoRole } from "./permissions";
import { promptSetFreezeTransition, promptTransition } from "./prompt-state";
import type { GeoTransitionActor } from "./transition";

const actor = (id: string, ...roles: GeoRole[]): GeoTransitionActor => ({ kind: "principal", id, roles });

describe("prompt review", () => {
	it("does not let the author approve or reject their own question, whatever roles they hold", () => {
		const both = actor("u1", "geo_operator", "marketing_reviewer");
		for (const action of ["APPROVE", "REJECT"] as const) {
			expect(
				promptTransition({ status: "IN_REVIEW", action, actor: both, comment: "意见", authorIds: ["u1"] }),
			).toMatchObject({ ok: false, code: "FORBIDDEN" });
		}
	});

	it("lets a different reviewer approve into the baseline", () => {
		expect(
			promptTransition({
				status: "IN_REVIEW",
				action: "APPROVE",
				actor: actor("u2", "marketing_reviewer"),
				authorIds: ["u1"],
			}),
		).toEqual({ ok: true, to: "BASELINE" });
	});

	it("keeps an operator without a review role from approving at all", () => {
		expect(
			promptTransition({ status: "IN_REVIEW", action: "APPROVE", actor: actor("u3", "geo_operator"), authorIds: [] }),
		).toMatchObject({ ok: false, code: "FORBIDDEN" });
	});

	it("never re-freezes a frozen set: changes have to become a new version", () => {
		expect(promptSetFreezeTransition("FROZEN", actor("u1", "geo_operator"), 20)).toMatchObject({
			ok: false,
			code: "CONFLICT",
		});
	});
});
