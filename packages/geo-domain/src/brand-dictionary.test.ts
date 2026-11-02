import { describe, expect, it } from "vitest";
import {
	dedupeBrandTerms,
	diffDictionarySnapshots,
	findBrandConflicts,
	type GeoBrandConflictSubject,
	type GeoDictionaryEntity,
	normalizeBrandDomain,
} from "./brand-dictionary";

const own: GeoBrandConflictSubject = {
	id: "own",
	status: "ACTIVE",
	displayName: "示例电气",
	legalName: "示例电气设备有限公司",
	shortName: null,
	aliases: ["示例电气厂"],
	historicalNames: [],
	domains: ["www.example-electric.test"],
};

describe("alias deduplication", () => {
	it("stores a name once whatever its width, case or spacing", () => {
		expect(dedupeBrandTerms(["ＡＢＣ 开关", "abc  开关", "ABC开关", "  "])).toEqual(["ＡＢＣ 开关", "ABC开关"]);
	});

	it("drops an alias that repeats the entity's own name", () => {
		expect(dedupeBrandTerms(["示例电气", "示例开关"], ["示例电气", null])).toEqual(["示例开关"]);
	});
});

describe("brand conflicts", () => {
	it("refuses a competitor alias another entity already answers to", () => {
		const conflicts = findBrandConflicts({ displayName: "某竞品", aliases: ["示例电气厂"], domains: [] }, [own]);
		expect(conflicts).toEqual([{ field: "name", term: "示例电气厂", entityId: "own", entityName: "示例电气" }]);
	});

	it("treats www and the bare domain as the same site", () => {
		const conflicts = findBrandConflicts({ displayName: "某竞品", domains: ["example-electric.test"] }, [own]);
		expect(conflicts.map((conflict) => conflict.field)).toEqual(["domain"]);
	});

	it("lets an entity keep its own names when it is edited", () => {
		expect(findBrandConflicts({ ...own }, [own])).toEqual([]);
	});

	it("frees a disabled entity's aliases but not its display name", () => {
		const disabled = { ...own, status: "DISABLED" as const };
		expect(findBrandConflicts({ displayName: "新品牌", aliases: ["示例电气厂"] }, [disabled])).toEqual([]);
		expect(findBrandConflicts({ displayName: "示例电气" }, [disabled])).toHaveLength(1);
	});

	it("reduces a pasted URL to its host and rejects what is not one", () => {
		expect(normalizeBrandDomain("HTTPS://WWW.Example-Electric.test:443/about")).toBe("www.example-electric.test");
		expect(normalizeBrandDomain("not a domain")).toBeNull();
	});
});

describe("dictionary history", () => {
	const entity = (aliases: string[]): GeoDictionaryEntity => ({
		id: "own",
		kind: "OWN",
		displayName: "示例电气",
		legalName: null,
		shortName: null,
		aliases,
		historicalNames: [],
		domains: [],
		officialUrl: null,
		regions: [],
		status: "ACTIVE",
		factStatus: "UNVERIFIED",
	});

	it("records which aliases a version added and removed", () => {
		const [change] = diffDictionarySnapshots(
			{ entities: [entity(["旧称", "示例开关"])], products: [] },
			{ entities: [entity(["示例开关", "新称"])], products: [] },
		);
		expect(change).toMatchObject({ addedAliases: ["新称"], removedAliases: ["旧称"] });
	});

	it("leaves untouched entities out of a version's changes", () => {
		const snapshot = { entities: [entity(["示例开关"])], products: [] };
		expect(diffDictionarySnapshots(snapshot, structuredClone(snapshot))).toEqual([]);
	});
});
