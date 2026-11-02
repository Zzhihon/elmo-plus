import { createHash } from "node:crypto";
import {
	assertGeoPermission,
	GEO_FINDING_SEVERITIES,
	GEO_FINDING_STATUSES,
	GEO_PRIORITIES,
	GeoError,
	type GeoFindingStatus,
	type GeoPrincipal,
	type GeoPriority,
	type GeoRiskLevel,
	type GeoTaskKind,
} from "@workspace/geo-domain";
import {
	SITE_AUDIT_DEPARTMENTS,
	SITE_AUDIT_RULE_GROUPS,
	SITE_AUDIT_RULES,
	type SiteAuditRule,
	siteAuditRule,
	triageFinding,
} from "@workspace/geo-site-ingestion/audit";
import {
	createSiteAuditRun,
	enqueueSiteAuditRun,
	loadSiteAuditRun,
	type SiteAuditFindingRow,
	type SiteAuditRunCounts,
	type SiteAuditRunRow,
} from "@workspace/geo-site-ingestion/audit/store";
import type { SendJob } from "@workspace/geo-site-ingestion/store";
import { db } from "@workspace/lib/db/db";
import type { DbConnection } from "@workspace/lib/db/db-connection";
import {
	geoOptimizationTasks,
	geoPrompts,
	geoSiteAuditFindings,
	geoSiteAuditRuns,
	geoSitePages,
	geoSitePageVersions,
	geoSiteSources,
	geoTaskEvidence,
} from "@workspace/lib/db/schema";
import { writeGeoAudit } from "@workspace/lib/geo/audit";
import { createOptimizationTask } from "@workspace/lib/geo/tasks";
import { and, asc, count, desc, eq, ilike, inArray, isNull, or, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import { enqueueGeoJob } from "@/lib/geo/enqueue";

const send: SendJob = (queue, data, options) => enqueueGeoJob(queue, data, options);

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

export interface Paging {
	page: number;
	limit: number;
	offset: number;
}

const OPEN_STATUSES: GeoFindingStatus[] = ["OPEN", "TASKED"];

function rulesInGroup(group: string): string[] {
	return SITE_AUDIT_RULES.filter((rule) => rule.group === group).map((rule) => rule.id);
}

async function assertSource(principal: GeoPrincipal, siteSourceId: string) {
	const [source] = await db
		.select({ id: geoSiteSources.id, baseUrl: geoSiteSources.baseUrl })
		.from(geoSiteSources)
		.where(and(eq(geoSiteSources.organizationId, principal.organizationId), eq(geoSiteSources.id, siteSourceId)))
		.limit(1);
	if (!source) throw new GeoError("NOT_FOUND", "站点不存在");
	return source;
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

function runView(run: SiteAuditRunRow) {
	return {
		id: run.id,
		siteSourceId: run.siteSourceId,
		status: run.status,
		ruleVersion: run.ruleVersion,
		counts: run.counts as Partial<SiteAuditRunCounts>,
		requestedBy: run.requestedBy,
		crawlRunId: run.crawlRunId,
		siteChecks: run.siteChecks,
		errorSummary: run.errorSummary,
		createdAt: run.createdAt,
		startedAt: run.startedAt,
		finishedAt: run.finishedAt,
	};
}
export type SiteAuditRunView = ReturnType<typeof runView>;

export const auditRunCreateSchema = z.object({ siteSourceId: z.string().uuid() });

/** Records the run, then queues it after commit; the job id is what a caller polls by. */
export async function startSiteAudit(
	principal: GeoPrincipal,
	input: z.infer<typeof auditRunCreateSchema> & { idempotencyKey?: string | null },
) {
	assertGeoPermission(principal, "site_audit.run");
	await assertSource(principal, input.siteSourceId);
	const { run, created } = await db.transaction((tx) =>
		createSiteAuditRun(tx, principal, {
			siteSourceId: input.siteSourceId,
			idempotencyKey: input.idempotencyKey ? `api:${input.idempotencyKey}` : null,
			siteChecks: true,
		}),
	);
	const jobId = run.status === "QUEUED" ? await enqueueSiteAuditRun(send, run, created ? {} : { tag: "manual" }) : null;
	return { run: runView(run), created, jobId };
}

export const auditRunFilterSchema = z.object({ siteSourceId: z.string().uuid().optional() });

export async function listSiteAuditRuns(
	principal: GeoPrincipal,
	filters: z.infer<typeof auditRunFilterSchema>,
	paging: Paging,
) {
	assertGeoPermission(principal, "site_audit.read");
	const where = and(
		eq(geoSiteAuditRuns.organizationId, principal.organizationId),
		filters.siteSourceId ? eq(geoSiteAuditRuns.siteSourceId, filters.siteSourceId) : undefined,
	);
	const [rows, [{ value: total }]] = await Promise.all([
		db
			.select()
			.from(geoSiteAuditRuns)
			.where(where)
			.orderBy(desc(geoSiteAuditRuns.createdAt))
			.limit(paging.limit)
			.offset(paging.offset),
		db.select({ value: count() }).from(geoSiteAuditRuns).where(where),
	]);
	return { rows: rows.map(runView), total };
}

export async function getSiteAuditRun(principal: GeoPrincipal, runId: string) {
	assertGeoPermission(principal, "site_audit.read");
	return runView(await loadSiteAuditRun(db, principal.organizationId, runId));
}

/** The latest run, the latest one that probed the site, and open counts: the head of the audit page. */
export async function getSiteAuditOverview(principal: GeoPrincipal, siteSourceId: string) {
	assertGeoPermission(principal, "site_audit.read");
	const source = await assertSource(principal, siteSourceId);
	const runsOf = (extra?: SQL) =>
		db
			.select()
			.from(geoSiteAuditRuns)
			.where(
				and(
					eq(geoSiteAuditRuns.organizationId, principal.organizationId),
					eq(geoSiteAuditRuns.siteSourceId, siteSourceId),
					extra,
				),
			)
			.orderBy(desc(geoSiteAuditRuns.createdAt))
			.limit(1);
	const [[latest], [lastProbe], byStatus, openByRule] = await Promise.all([
		runsOf(),
		runsOf(and(eq(geoSiteAuditRuns.status, "SUCCEEDED"), sql`${geoSiteAuditRuns.counts} -> 'site' is not null`)),
		db
			.select({ status: geoSiteAuditFindings.status, value: count() })
			.from(geoSiteAuditFindings)
			.where(
				and(
					eq(geoSiteAuditFindings.organizationId, principal.organizationId),
					eq(geoSiteAuditFindings.siteSourceId, siteSourceId),
				),
			)
			.groupBy(geoSiteAuditFindings.status),
		db
			.select({
				ruleId: geoSiteAuditFindings.ruleId,
				severity: geoSiteAuditFindings.severity,
				value: count(),
			})
			.from(geoSiteAuditFindings)
			.where(
				and(
					eq(geoSiteAuditFindings.organizationId, principal.organizationId),
					eq(geoSiteAuditFindings.siteSourceId, siteSourceId),
					inArray(geoSiteAuditFindings.status, OPEN_STATUSES),
				),
			)
			.groupBy(geoSiteAuditFindings.ruleId, geoSiteAuditFindings.severity),
	]);
	const openByGroup: Record<string, number> = {};
	const openBySeverity: Record<string, number> = {};
	for (const row of openByRule) {
		const group = siteAuditRule(row.ruleId)?.group ?? "OTHER";
		openByGroup[group] = (openByGroup[group] ?? 0) + row.value;
		openBySeverity[row.severity] = (openBySeverity[row.severity] ?? 0) + row.value;
	}
	return {
		source,
		latestRun: latest ? runView(latest) : null,
		siteChecks: lastProbe ? { runId: lastProbe.id, ...(lastProbe.counts as SiteAuditRunCounts).site } : null,
		byStatus: Object.fromEntries(byStatus.map((row) => [row.status, row.value])) as Partial<
			Record<GeoFindingStatus, number>
		>,
		openByGroup,
		openBySeverity,
	};
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

const csv = <T extends string>(values: readonly [T, ...T[]]) =>
	z.union([z.array(z.enum(values)), z.enum(values).transform((value) => [value])]).optional();

export const findingFilterSchema = z.object({
	siteSourceId: z.string().uuid().optional(),
	status: csv(GEO_FINDING_STATUSES),
	severity: z.enum(GEO_FINDING_SEVERITIES).optional(),
	priority: z.enum(GEO_PRIORITIES).optional(),
	group: z.enum(SITE_AUDIT_RULE_GROUPS).optional(),
	department: z.enum(SITE_AUDIT_DEPARTMENTS).optional(),
	ruleId: z.string().max(80).optional(),
	pageId: z.string().uuid().optional(),
	/** `site` for site-wide findings only. */
	scope: z.enum(["page", "site"]).optional(),
	q: z.string().max(200).optional(),
});
export type FindingFilters = z.infer<typeof findingFilterSchema>;

function findingWhere(principal: GeoPrincipal, filters: FindingFilters): SQL | undefined {
	return and(
		eq(geoSiteAuditFindings.organizationId, principal.organizationId),
		filters.siteSourceId ? eq(geoSiteAuditFindings.siteSourceId, filters.siteSourceId) : undefined,
		filters.status?.length ? inArray(geoSiteAuditFindings.status, filters.status) : undefined,
		filters.severity ? eq(geoSiteAuditFindings.severity, filters.severity) : undefined,
		filters.priority ? eq(geoSiteAuditFindings.priority, filters.priority) : undefined,
		filters.group ? inArray(geoSiteAuditFindings.ruleId, rulesInGroup(filters.group)) : undefined,
		filters.department ? eq(geoSiteAuditFindings.ownerDepartment, filters.department) : undefined,
		filters.ruleId ? eq(geoSiteAuditFindings.ruleId, filters.ruleId) : undefined,
		filters.pageId ? eq(geoSiteAuditFindings.pageId, filters.pageId) : undefined,
		filters.scope === "site" ? isNull(geoSiteAuditFindings.pageId) : undefined,
		filters.scope === "page" ? sql`${geoSiteAuditFindings.pageId} is not null` : undefined,
		filters.q
			? or(ilike(geoSitePages.normalizedUrl, `%${filters.q}%`), ilike(geoSiteAuditFindings.ruleId, `%${filters.q}%`))
			: undefined,
	);
}

const findingColumns = {
	finding: geoSiteAuditFindings,
	pageUrl: geoSitePages.normalizedUrl,
	pageStatus: geoSitePages.status,
	pageCategory: geoSitePages.category,
	taskTitle: geoOptimizationTasks.title,
	taskState: geoOptimizationTasks.state,
};

type FindingJoinRow = {
	finding: SiteAuditFindingRow;
	pageUrl: string | null;
	pageStatus: string | null;
	pageCategory: string | null;
	taskTitle: string | null;
	taskState: string | null;
};

function ruleView(rule: SiteAuditRule | undefined, ruleId: string) {
	return rule
		? {
				id: rule.id,
				title: rule.title,
				group: rule.group,
				description: rule.description,
				scope: rule.scope,
			}
		: { id: ruleId, title: ruleId, group: null, description: null, scope: null };
}

function findingView(row: FindingJoinRow) {
	const { finding } = row;
	const evidence = finding.evidence as { summary?: string; taskKind?: GeoTaskKind; title?: string | null };
	return {
		id: finding.id,
		siteSourceId: finding.siteSourceId,
		ruleId: finding.ruleId,
		ruleVersion: finding.ruleVersion,
		rule: ruleView(siteAuditRule(finding.ruleId), finding.ruleId),
		severity: finding.severity,
		priority: finding.priority,
		status: finding.status,
		statusNote: finding.statusNote,
		summary: evidence.summary ?? null,
		taskKind: evidence.taskKind ?? siteAuditRule(finding.ruleId)?.taskKind ?? "SITE_REVISION",
		evidence: finding.evidence as JsonObject,
		recommendation: finding.recommendation,
		ownerDepartment: finding.ownerDepartment,
		targetPromptIds: finding.targetPromptIds,
		page: finding.pageId
			? {
					id: finding.pageId,
					url: row.pageUrl,
					status: row.pageStatus,
					category: row.pageCategory,
					title: evidence.title ?? null,
				}
			: null,
		pageVersionId: finding.pageVersionId,
		task: finding.taskId ? { id: finding.taskId, title: row.taskTitle, state: row.taskState } : null,
		firstRunId: finding.runId,
		lastRunId: finding.lastRunId,
		firstSeenAt: finding.firstSeenAt,
		lastSeenAt: finding.lastSeenAt,
		resolvedAt: finding.resolvedAt,
		triagedBy: finding.triagedBy,
		triagedAt: finding.triagedAt,
	};
}
export type SiteAuditFindingView = ReturnType<typeof findingView>;

function findingQuery(where: SQL | undefined) {
	return db
		.select(findingColumns)
		.from(geoSiteAuditFindings)
		.leftJoin(geoSitePages, eq(geoSitePages.id, geoSiteAuditFindings.pageId))
		.leftJoin(geoOptimizationTasks, eq(geoOptimizationTasks.id, geoSiteAuditFindings.taskId))
		.where(where);
}

const PRIORITY_ORDER = sql`case ${geoSiteAuditFindings.priority} when 'P0' then 0 when 'P1' then 1 when 'P2' then 2 else 3 end`;

export async function listSiteAuditFindings(principal: GeoPrincipal, filters: FindingFilters, paging: Paging) {
	assertGeoPermission(principal, "site_audit.read");
	const where = findingWhere(principal, filters);
	const [rows, [{ value: total }]] = await Promise.all([
		findingQuery(where)
			.orderBy(PRIORITY_ORDER, asc(geoSitePages.normalizedUrl), asc(geoSiteAuditFindings.ruleId))
			.limit(paging.limit)
			.offset(paging.offset),
		db
			.select({ value: count() })
			.from(geoSiteAuditFindings)
			.leftJoin(geoSitePages, eq(geoSitePages.id, geoSiteAuditFindings.pageId))
			.where(where),
	]);
	return { rows: rows.map(findingView), total };
}

const SUBJECT = sql<string>`coalesce(${geoSiteAuditFindings.pageId}::text, 'site')`;

/**
 * Findings grouped by page, paged by page: the site-wide group first, then pages
 * ordered by their most urgent finding.
 */
export async function listSiteAuditFindingGroups(principal: GeoPrincipal, filters: FindingFilters, paging: Paging) {
	assertGeoPermission(principal, "site_audit.read");
	const where = findingWhere(principal, filters);
	const subjects = db
		.select({
			subject: SUBJECT.as("subject"),
			top: sql<number>`min(${PRIORITY_ORDER})`.as("top"),
			findings: count().as("findings"),
			url: sql<string | null>`min(${geoSitePages.normalizedUrl})`.as("url"),
		})
		.from(geoSiteAuditFindings)
		.leftJoin(geoSitePages, eq(geoSitePages.id, geoSiteAuditFindings.pageId))
		.where(where)
		.groupBy(SUBJECT)
		.as("subjects");
	const [groups, [{ value: total }]] = await Promise.all([
		db
			.select()
			.from(subjects)
			.orderBy(sql`${subjects.subject} = 'site' desc`, asc(subjects.top), desc(subjects.findings), asc(subjects.url))
			.limit(paging.limit)
			.offset(paging.offset),
		db.select({ value: count() }).from(subjects),
	]);
	const pageIds = groups.map((group) => group.subject).filter((subject) => subject !== "site");
	const includeSite = groups.some((group) => group.subject === "site");
	const subjectFilter =
		pageIds.length > 0 || includeSite
			? or(
					pageIds.length > 0 ? inArray(geoSiteAuditFindings.pageId, pageIds) : undefined,
					includeSite ? isNull(geoSiteAuditFindings.pageId) : undefined,
				)
			: sql`false`;
	const rows = await findingQuery(and(where, subjectFilter)).orderBy(PRIORITY_ORDER, asc(geoSiteAuditFindings.ruleId));
	const views = rows.map(findingView);
	return {
		rows: groups.map((group) => {
			const findings = views.filter((view) => (view.page?.id ?? "site") === group.subject);
			return {
				subject: group.subject,
				page: findings[0]?.page ?? null,
				findings,
			};
		}),
		total,
	};
}

async function loadFinding(principal: GeoPrincipal, findingId: string, tx: DbConnection = db) {
	const [row] = await tx
		.select()
		.from(geoSiteAuditFindings)
		.where(
			and(eq(geoSiteAuditFindings.organizationId, principal.organizationId), eq(geoSiteAuditFindings.id, findingId)),
		)
		.limit(1);
	if (!row) throw new GeoError("NOT_FOUND", "审计发现不存在");
	return row;
}

export async function getSiteAuditFinding(principal: GeoPrincipal, findingId: string) {
	assertGeoPermission(principal, "site_audit.read");
	const [row] = await findingQuery(
		and(eq(geoSiteAuditFindings.organizationId, principal.organizationId), eq(geoSiteAuditFindings.id, findingId)),
	).limit(1);
	if (!row) throw new GeoError("NOT_FOUND", "审计发现不存在");
	const view = findingView(row);
	const [version, prompts] = await Promise.all([
		view.pageVersionId
			? db
					.select({
						id: geoSitePageVersions.id,
						fetchedAt: geoSitePageVersions.fetchedAt,
						parserVersion: geoSitePageVersions.parserVersion,
						contentHash: geoSitePageVersions.contentHash,
					})
					.from(geoSitePageVersions)
					.where(
						and(
							eq(geoSitePageVersions.organizationId, principal.organizationId),
							eq(geoSitePageVersions.id, view.pageVersionId),
						),
					)
					.limit(1)
			: Promise.resolve([]),
		view.targetPromptIds.length > 0
			? db
					.select({
						id: geoPrompts.id,
						question: geoPrompts.question,
						status: geoPrompts.status,
						productLine: geoPrompts.productLine,
					})
					.from(geoPrompts)
					.where(
						and(eq(geoPrompts.organizationId, principal.organizationId), inArray(geoPrompts.id, view.targetPromptIds)),
					)
			: Promise.resolve([]),
	]);
	const rule = siteAuditRule(view.ruleId);
	return {
		...view,
		rule: rule ?? view.rule,
		defaultRecommendation: rule?.recommendation ?? null,
		version: version[0] ?? null,
		targetPrompts: prompts,
	};
}

export const findingPatchSchema = z
	.object({
		status: z.enum(["OPEN", "DISMISSED"]).optional(),
		note: z.string().trim().max(1000).nullable().optional(),
		priority: z.enum(GEO_PRIORITIES).optional(),
		ownerDepartment: z.enum(SITE_AUDIT_DEPARTMENTS).optional(),
		targetPromptIds: z.array(z.string().uuid()).max(20).optional(),
		recommendation: z.string().trim().min(1).max(4000).optional(),
	})
	.refine((patch) => Object.values(patch).some((value) => value !== undefined), "至少修改一项");
export type FindingPatch = z.infer<typeof findingPatchSchema>;

async function assertPromptsInOrganization(tx: DbConnection, organizationId: string, ids: string[]) {
	if (ids.length === 0) return;
	const rows = await tx
		.select({ id: geoPrompts.id })
		.from(geoPrompts)
		.where(and(eq(geoPrompts.organizationId, organizationId), inArray(geoPrompts.id, ids)));
	if (rows.length !== new Set(ids).size) throw new GeoError("NOT_FOUND", "问法不存在或不属于当前组织");
}

type FindingChanges = Partial<typeof geoSiteAuditFindings.$inferInsert>;

async function triageChanges(
	tx: DbConnection,
	principal: GeoPrincipal,
	before: SiteAuditFindingRow,
	patch: FindingPatch,
): Promise<FindingChanges> {
	const changes: FindingChanges = {};
	if (patch.status && patch.status !== before.status) {
		const result = triageFinding(before.status, patch.status, patch.note);
		if (!result.ok) throw new GeoError(result.code, result.message);
		changes.status = result.to;
		changes.statusNote = patch.note?.trim() || null;
	}
	if (patch.priority) changes.priority = patch.priority;
	if (patch.ownerDepartment) changes.ownerDepartment = patch.ownerDepartment;
	if (patch.recommendation) changes.recommendation = patch.recommendation;
	if (patch.targetPromptIds) {
		const ids = [...new Set(patch.targetPromptIds)];
		await assertPromptsInOrganization(tx, principal.organizationId, ids);
		changes.targetPromptIds = ids;
	}
	return changes;
}

function triageAction(changes: FindingChanges): string {
	if (changes.status === "DISMISSED") return "site_audit.finding.dismiss";
	if (changes.status === "OPEN") return "site_audit.finding.reopen";
	return "site_audit.finding.update";
}

/** Triage by a person: dismiss or restore, and adjust priority, department, target questions and advice. */
export async function updateSiteAuditFinding(principal: GeoPrincipal, findingId: string, patch: FindingPatch) {
	assertGeoPermission(principal, "site_audit.triage");
	await db.transaction(async (tx) => {
		const before = await loadFinding(principal, findingId, tx);
		const changes = await triageChanges(tx, principal, before, patch);
		const [after] = await tx
			.update(geoSiteAuditFindings)
			.set({ ...changes, triagedBy: principal.actorId, triagedAt: sql`now()` })
			.where(eq(geoSiteAuditFindings.id, before.id))
			.returning();
		await writeGeoAudit(tx, {
			principal,
			action: triageAction(changes),
			entityType: "site_audit_finding",
			entityId: before.id,
			before,
			after,
			metadata: { fields: Object.keys(changes), ruleId: before.ruleId },
		});
	});
	return getSiteAuditFinding(principal, findingId);
}

// ---------------------------------------------------------------------------
// Tasks from findings
// ---------------------------------------------------------------------------

export const findingTasksSchema = z.object({
	findingIds: z.array(z.string().uuid()).min(1).max(200),
	/** One task per finding, one per page, or one for everything selected. */
	mode: z.enum(["PER_FINDING", "PER_PAGE", "MERGED"]).default("PER_PAGE"),
	priority: z.enum(GEO_PRIORITIES).optional(),
});
export type FindingTasksInput = z.infer<typeof findingTasksSchema>;

const PRIORITY_RANK: Record<GeoPriority, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
const TECHNICAL_RULES = new Set(["product.param_source_missing", "product.selection_missing"]);

type FindingWithPage = { finding: SiteAuditFindingRow; pageUrl: string | null };

function taskKindOf(findings: SiteAuditFindingRow[]): GeoTaskKind {
	const kinds = new Set(
		findings.map(
			(finding) =>
				(finding.evidence as { taskKind?: GeoTaskKind }).taskKind ??
				siteAuditRule(finding.ruleId)?.taskKind ??
				"SITE_REVISION",
		),
	);
	return kinds.size === 1 ? ([...kinds][0] as GeoTaskKind) : "SITE_REVISION";
}

function subjectLabel(entry: FindingWithPage): string {
	const title = (entry.finding.evidence as { title?: string | null }).title;
	if (!entry.finding.pageId) return "全站";
	return title ? `${title}（${entry.pageUrl ?? ""}）` : (entry.pageUrl ?? "页面");
}

function taskInput(group: FindingWithPage[], mode: FindingTasksInput["mode"], input: FindingTasksInput) {
	const findings = group.map((entry) => entry.finding);
	const sortedIds = findings.map((finding) => finding.id).sort();
	const first = group[0];
	const rule = siteAuditRule(first.finding.ruleId);
	const sourceRef =
		mode === "PER_FINDING"
			? `finding:${first.finding.id}`
			: mode === "PER_PAGE"
				? `site-audit:${first.finding.siteSourceId}:${first.finding.pageId ?? "site"}`
				: `site-audit-batch:${createHash("sha256").update(sortedIds.join(",")).digest("hex").slice(0, 24)}`;
	const title =
		mode === "PER_FINDING"
			? `${rule?.title ?? first.finding.ruleId}：${subjectLabel(first)}`
			: mode === "PER_PAGE"
				? `官网整改：${subjectLabel(first)}（${findings.length} 项）`
				: `官网整改：${findings.length} 项站点审计发现`;
	const priority =
		input.priority ??
		findings.reduce<GeoPriority>(
			(best, finding) => (PRIORITY_RANK[finding.priority] < PRIORITY_RANK[best] ? finding.priority : best),
			"P3",
		);
	const riskLevel: GeoRiskLevel = findings.some((finding) => TECHNICAL_RULES.has(finding.ruleId)) ? "HIGH" : "NORMAL";
	const recommendedAction = group
		.map((entry) => {
			const label = siteAuditRule(entry.finding.ruleId)?.title ?? entry.finding.ruleId;
			const where = mode === "MERGED" && entry.finding.pageId ? `［${entry.pageUrl}］` : "";
			return `· ${where}${label}：${entry.finding.recommendation ?? ""}`;
		})
		.join("\n");
	return {
		title: title.slice(0, 200),
		kind: taskKindOf(findings),
		sourceKind: "FINDING" as const,
		sourceRef,
		priority,
		riskLevel,
		promptId: findings.find((finding) => finding.targetPromptIds.length > 0)?.targetPromptIds[0] ?? null,
		recommendedAction: recommendedAction.slice(0, 8000),
		expectedMetric: "官网整改上线后复跑站点审计，关联发现转为“已解决”；再按目标问法复测 AI 回答",
		evidence: { findingIds: sortedIds },
		comment: "由站点审计发现创建；平台不直接修改官网，整改需在官网系统中实施并登记发布凭证",
	};
}

/**
 * When the task for that source already existed, `createOptimizationTask` returns
 * it untouched; the newly selected findings are attached to it here so they do
 * not stay open beside a task that covers them.
 */
async function attachToExistingTask(
	tx: DbConnection,
	principal: GeoPrincipal,
	taskId: string,
	findingIds: string[],
): Promise<void> {
	await tx
		.insert(geoTaskEvidence)
		.values(findingIds.map((findingId) => ({ organizationId: principal.organizationId, taskId, findingId })))
		.onConflictDoNothing();
	const attached = await tx
		.update(geoSiteAuditFindings)
		.set({ status: "TASKED", taskId })
		.where(
			and(
				eq(geoSiteAuditFindings.organizationId, principal.organizationId),
				inArray(geoSiteAuditFindings.id, findingIds),
				eq(geoSiteAuditFindings.status, "OPEN"),
			),
		)
		.returning({ id: geoSiteAuditFindings.id });
	if (attached.length === 0) return;
	await writeGeoAudit(tx, {
		principal,
		action: "site_audit.finding.attach_task",
		entityType: "geo_optimization_task",
		entityId: taskId,
		metadata: { findingIds: attached.map((row) => row.id) },
	});
}

function groupFindings(rows: FindingWithPage[], mode: FindingTasksInput["mode"]): FindingWithPage[][] {
	if (mode === "PER_FINDING") return rows.map((row) => [row]);
	if (mode === "MERGED") return [rows];
	const groups = new Map<string, FindingWithPage[]>();
	for (const row of rows) {
		const key = row.finding.pageId ?? "site";
		groups.set(key, [...(groups.get(key) ?? []), row]);
	}
	return [...groups.values()];
}

/** One click (or one batch) from findings to optimization tasks, all through the shared task entry point. */
export async function createTasksFromFindings(principal: GeoPrincipal, input: FindingTasksInput) {
	assertGeoPermission(principal, "site_audit.read");
	assertGeoPermission(principal, "task.create");
	return db.transaction(async (tx) => {
		const rows = await tx
			.select({ finding: geoSiteAuditFindings, pageUrl: geoSitePages.normalizedUrl })
			.from(geoSiteAuditFindings)
			.leftJoin(geoSitePages, eq(geoSitePages.id, geoSiteAuditFindings.pageId))
			.where(
				and(
					eq(geoSiteAuditFindings.organizationId, principal.organizationId),
					inArray(geoSiteAuditFindings.id, input.findingIds),
				),
			)
			.orderBy(asc(geoSitePages.normalizedUrl), asc(geoSiteAuditFindings.ruleId))
			.for("update", { of: geoSiteAuditFindings });
		if (rows.length !== new Set(input.findingIds).size) {
			throw new GeoError("NOT_FOUND", "部分审计发现不存在或不属于当前组织");
		}
		const eligible = rows.filter((row) => row.finding.status === "OPEN");
		const skipped = rows
			.filter((row) => row.finding.status !== "OPEN")
			.map((row) => ({ findingId: row.finding.id, status: row.finding.status }));
		if (eligible.length === 0) {
			throw new GeoError("CONFLICT", "所选发现都不是待处理状态，已建工单、已解决或已忽略的发现不能再建工单");
		}
		const sources = new Set(eligible.map((row) => row.finding.siteSourceId));
		if (input.mode === "MERGED" && sources.size > 1) {
			throw new GeoError("VALIDATION_ERROR", "合并为一张工单时，所选发现必须属于同一站点");
		}

		const tasks: Array<{ id: string; title: string; created: boolean; findingIds: string[] }> = [];
		for (const group of groupFindings(eligible, input.mode)) {
			const taskFields = taskInput(group, input.mode, input);
			const { task, created } = await createOptimizationTask(tx, principal, taskFields);
			if (!created) await attachToExistingTask(tx, principal, task.id, taskFields.evidence.findingIds);
			tasks.push({ id: task.id, title: task.title, created, findingIds: taskFields.evidence.findingIds });
		}
		return { tasks, skipped };
	});
}

export async function listAuditPromptChoices(principal: GeoPrincipal) {
	assertGeoPermission(principal, "site_audit.read");
	return db
		.select({
			id: geoPrompts.id,
			question: geoPrompts.question,
			productLine: geoPrompts.productLine,
			status: geoPrompts.status,
		})
		.from(geoPrompts)
		.where(and(eq(geoPrompts.organizationId, principal.organizationId), sql`${geoPrompts.status} <> 'REJECTED'`))
		.orderBy(asc(geoPrompts.productLine), asc(geoPrompts.question))
		.limit(500);
}

export async function listAuditSources(principal: GeoPrincipal) {
	assertGeoPermission(principal, "site_audit.read");
	return db
		.select({ id: geoSiteSources.id, baseUrl: geoSiteSources.baseUrl, enabled: geoSiteSources.enabled })
		.from(geoSiteSources)
		.where(eq(geoSiteSources.organizationId, principal.organizationId))
		.orderBy(asc(geoSiteSources.baseUrl));
}
