import type { GeoFindingStatus } from "@workspace/geo-domain";
import type { AuditDetection } from "./rules";

export const SITE_SUBJECT = "site";

export function subjectKeyOf(pageId: string | null): string {
	return pageId ?? SITE_SUBJECT;
}

export interface ExistingFinding {
	id: string;
	ruleId: string;
	pageId: string | null;
	status: GeoFindingStatus;
	/** The linked task is still being worked on, so a regression goes back to it rather than to the queue. */
	taskOpen: boolean;
}

export interface ReconcileScope {
	/** Page rules that ran, over exactly these pages. */
	pageRuleIds: readonly string[];
	auditedPageIds: ReadonlySet<string>;
	siteRuleIds: readonly string[];
	/** Pages that are now gone, redirected or blocked: what was wrong with their content no longer applies. */
	unavailablePageIds: ReadonlySet<string>;
}

export type ReconcileAction =
	| { kind: "INSERT"; detection: AuditDetection }
	| { kind: "REFRESH"; findingId: string; detection: AuditDetection; status: GeoFindingStatus; reopened: boolean }
	| { kind: "RESOLVE"; findingId: string; note: string };

const STILL_OPEN: GeoFindingStatus[] = ["OPEN", "TASKED"];

/**
 * One finding per rule and page (or per rule for the site) lives across runs.
 * Seen again: refreshed, and reopened if it had been fixed; a tasked one whose
 * task was cancelled or verified while the problem remains goes back to open.
 * Not seen again by a rule that did look at that subject: resolved. A dismissed finding stays
 * dismissed either way; that was a person's decision.
 */
function keyOf(entry: { ruleId: string; pageId: string | null }): string {
	return `${entry.ruleId}|${subjectKeyOf(entry.pageId)}`;
}

function seenAgain(finding: ExistingFinding, detection: AuditDetection): ReconcileAction {
	const reopened = finding.status === "RESOLVED";
	const backToTask = reopened || finding.status === "TASKED";
	const status: GeoFindingStatus = backToTask ? (finding.taskOpen ? "TASKED" : "OPEN") : finding.status;
	return { kind: "REFRESH", findingId: finding.id, detection, status, reopened };
}

function notSeenAgain(finding: ExistingFinding, scope: ReconcileScope): ReconcileAction | null {
	if (!STILL_OPEN.includes(finding.status)) return null;
	const fixed: ReconcileAction = { kind: "RESOLVE", findingId: finding.id, note: "复跑审计时未再发现" };
	if (finding.pageId === null) return scope.siteRuleIds.includes(finding.ruleId) ? fixed : null;
	if (scope.auditedPageIds.has(finding.pageId) && scope.pageRuleIds.includes(finding.ruleId)) return fixed;
	if (scope.unavailablePageIds.has(finding.pageId)) {
		return { kind: "RESOLVE", findingId: finding.id, note: "页面已不可访问，失效链接会在引用它的页面上另行报告" };
	}
	return null;
}

export function reconcileFindings(
	existing: readonly ExistingFinding[],
	detections: readonly AuditDetection[],
	scope: ReconcileScope,
): ReconcileAction[] {
	const byKey = new Map(existing.map((finding) => [keyOf(finding), finding]));
	const seen = new Set<string>();
	const actions: ReconcileAction[] = [];
	for (const detection of detections) {
		const key = keyOf(detection);
		if (seen.has(key)) continue;
		seen.add(key);
		const finding = byKey.get(key);
		actions.push(finding ? seenAgain(finding, detection) : { kind: "INSERT", detection });
	}
	for (const finding of existing) {
		const action = seen.has(keyOf(finding)) ? null : notSeenAgain(finding, scope);
		if (action) actions.push(action);
	}
	return actions;
}
