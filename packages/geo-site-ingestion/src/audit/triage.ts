import type { GeoFindingStatus } from "@workspace/geo-domain";

export type FindingTriageTarget = "OPEN" | "DISMISSED";

export type FindingTriageResult =
	| { ok: true; to: FindingTriageTarget }
	| { ok: false; code: "CONFLICT" | "VALIDATION_ERROR"; message: string };

/**
 * What a person may do to a finding by hand. Tasking happens through a task,
 * resolving through a rerun; by hand a finding can only be dismissed with a
 * reason, or brought back from dismissal.
 */
export function triageFinding(
	from: GeoFindingStatus,
	to: FindingTriageTarget,
	note?: string | null,
): FindingTriageResult {
	if (to === "DISMISSED") {
		if (from !== "OPEN") {
			return {
				ok: false,
				code: "CONFLICT",
				message: from === "TASKED" ? "已关联工单的发现不能忽略，请在工单中处理" : "只有待处理的发现可以忽略",
			};
		}
		if (!note?.trim()) return { ok: false, code: "VALIDATION_ERROR", message: "忽略发现必须说明原因" };
		return { ok: true, to };
	}
	if (from !== "DISMISSED") return { ok: false, code: "CONFLICT", message: "只有已忽略的发现可以恢复为待处理" };
	return { ok: true, to };
}
