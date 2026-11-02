import { describe, expect, it } from "vitest";
import { metricValue } from "./metrics";
import { type ComparisonConditions, classifyTrend, type TrendPoint } from "./trends";

const conditions: ComparisonConditions = {
	promptSet: "set1@1",
	targets: "t1",
	regionLanguage: "CN/zh-CN",
	evaluatorVersions: "rules-v1",
};

function point(numerator: number, denominator: number, change: Partial<ComparisonConditions> = {}): TrendPoint {
	return {
		roundKey: `r${numerator}-${denominator}-${Math.random()}`,
		startedAt: "2026-10-01T00:00:00Z",
		validSamples: denominator,
		mentionRate: metricValue(numerator, denominator),
		recommendationRate: metricValue(0, denominator),
		conditions: { ...conditions, ...change },
		breakpoint: Object.keys(change) as (keyof ComparisonConditions)[],
	};
}

const mention = (entry: TrendPoint) => entry.mentionRate;

describe("trend wording", () => {
	it("calls two consecutive rises a sustained improvement", () => {
		expect(classifyTrend([point(10, 40), point(14, 40), point(20, 40)], mention).kind).toBe("SUSTAINED_IMPROVEMENT");
		expect(classifyTrend([point(20, 40), point(14, 40), point(10, 40)], mention).kind).toBe("SUSTAINED_DECLINE");
	});

	it("calls a single rise, or a rise after a fall, only an observed change", () => {
		expect(classifyTrend([point(10, 40), point(20, 40)], mention)).toMatchObject({
			kind: "OBSERVED_CHANGE",
			deltaPoints: 25,
		});
		expect(classifyTrend([point(14, 40), point(10, 40), point(20, 40)], mention).kind).toBe("OBSERVED_CHANGE");
	});

	it("will not call low-sample rounds sustained", () => {
		expect(classifyTrend([point(1, 5), point(2, 5), point(3, 5)], mention).kind).toBe("OBSERVED_CHANGE");
	});

	it("only compares rounds after a change of conditions", () => {
		const points = [point(10, 40), point(14, 40), point(20, 40, { evaluatorVersions: "rules-v2" }), point(22, 40)];
		expect(classifyTrend(points, mention).kind).toBe("OBSERVED_CHANGE");
		expect(classifyTrend([point(10, 40), point(20, 40, { promptSet: "set1@2" })], mention).kind).toBe("INSUFFICIENT");
	});

	it("skips rounds without data instead of treating them as zero", () => {
		const empty = { ...point(0, 0), mentionRate: metricValue(0, 0) };
		expect(classifyTrend([point(10, 40), empty, point(10, 40)], mention).kind).toBe("NO_CHANGE");
	});
});
