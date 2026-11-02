import { IconListCheck } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import {
	GEO_FINDING_SEVERITIES,
	GEO_FINDING_STATUSES,
	GEO_PRIORITIES,
	type GeoFindingSeverity,
	type GeoFindingStatus,
	type GeoPriority,
} from "@workspace/geo-domain";
import {
	SITE_AUDIT_DEPARTMENT_LABELS,
	SITE_AUDIT_DEPARTMENTS,
	SITE_AUDIT_FINDING_STATUS_LABELS,
	SITE_AUDIT_RULE_GROUP_LABELS,
	SITE_AUDIT_RULE_GROUPS,
	SITE_AUDIT_SEVERITY_LABELS,
	type SiteAuditDepartment,
	type SiteAuditRuleGroup,
} from "@workspace/geo-site-ingestion/audit/catalog";
import { Alert, AlertDescription } from "@workspace/ui/components/alert";
import { Button } from "@workspace/ui/components/button";
import { Card, CardContent, CardHeader } from "@workspace/ui/components/card";
import { Checkbox } from "@workspace/ui/components/checkbox";
import { Input } from "@workspace/ui/components/input";
import { Skeleton } from "@workspace/ui/components/skeleton";
import { useState } from "react";
import { GeoEmptyState } from "@/components/geo/shell/empty-state";
import { GeoStatusBadge } from "@/components/geo/shell/status-badge";
import { useGeoViewer } from "@/components/geo/shell/use-geo-viewer";
import { errorMessage, SitePageStatusBadge } from "@/components/geo/site-pages/site-labels";
import { PRIORITY_LABELS } from "@/components/geo/tasks/labels";
import { SimpleSelect } from "@/components/geo/tasks/simple-select";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { listSiteAuditFindingGroupsFn } from "@/server/geo/site-audit";
import { BatchTaskDialog } from "./batch-task-dialog";
import { FindingDialog } from "./finding-dialog";
import { departmentLabel, FindingStatusBadge, SeverityBadge, siteAuditKeys } from "./labels";

type Groups = Awaited<ReturnType<typeof listSiteAuditFindingGroupsFn>>;
type Group = Groups["rows"][number];
type Finding = Group["findings"][number];

const PAGE_SIZE = 10;
type StatusFilter = "ACTIVE" | GeoFindingStatus;

const STATUS_OPTIONS: Array<{ value: StatusFilter; label: string }> = [
	{ value: "ACTIVE", label: "待处理与已建工单" },
	...GEO_FINDING_STATUSES.map((value) => ({ value, label: SITE_AUDIT_FINDING_STATUS_LABELS[value] })),
];

function FindingRow({
	finding,
	selectable,
	selected,
	onSelect,
	onOpen,
}: {
	finding: Finding;
	selectable: boolean;
	selected: boolean;
	onSelect: (selected: boolean) => void;
	onOpen: () => void;
}) {
	return (
		<div className="flex items-start gap-3 border-t px-4 py-3 first:border-t-0">
			<div className="pt-0.5">
				{selectable ? (
					<Checkbox
						checked={selected}
						onCheckedChange={(checked) => onSelect(checked === true)}
						aria-label={`选择 ${finding.rule.title}`}
					/>
				) : (
					<span className="inline-block size-4" />
				)}
			</div>
			<button type="button" onClick={onOpen} className="flex min-w-0 flex-1 flex-col gap-1 text-left">
				<div className="flex flex-wrap items-center gap-2">
					<span className="text-sm font-medium">{finding.rule.title}</span>
					<SeverityBadge severity={finding.severity} />
					<GeoStatusBadge label={finding.priority} />
					<FindingStatusBadge status={finding.status} />
				</div>
				<span className="text-sm text-muted-foreground break-all">{finding.summary}</span>
				<span className="text-xs text-muted-foreground">
					{departmentLabel(finding.ownerDepartment)}
					{finding.targetPromptIds.length > 0 ? ` · 目标问法 ${finding.targetPromptIds.length} 条` : ""}
					{finding.task ? ` · 工单：${finding.task.title}` : ""}
				</span>
			</button>
		</div>
	);
}

function GroupCard({
	group,
	selected,
	canTask,
	onToggle,
	onOpen,
}: {
	group: Group;
	selected: Set<string>;
	canTask: boolean;
	onToggle: (ids: string[], on: boolean) => void;
	onOpen: (id: string) => void;
}) {
	const openIds = group.findings.filter((finding) => finding.status === "OPEN").map((finding) => finding.id);
	const allSelected = openIds.length > 0 && openIds.every((id) => selected.has(id));
	return (
		<Card className="gap-0 py-0">
			<CardHeader className="flex flex-row items-start gap-3 border-b px-4 py-3">
				<div className="pt-0.5">
					{canTask && openIds.length > 0 ? (
						<Checkbox
							checked={allSelected}
							onCheckedChange={(checked) => onToggle(openIds, checked === true)}
							aria-label="选择该页面的待处理发现"
						/>
					) : (
						<span className="inline-block size-4" />
					)}
				</div>
				<div className="flex min-w-0 flex-1 flex-col gap-0.5">
					{group.page ? (
						<>
							<div className="flex flex-wrap items-center gap-2">
								<span className="text-sm font-medium break-all">{group.page.title ?? "（无标题）"}</span>
								{group.page.status && group.page.status !== "ACTIVE" && (
									<SitePageStatusBadge status={group.page.status} />
								)}
							</div>
							<span className="text-xs text-muted-foreground break-all">{group.page.url}</span>
						</>
					) : (
						<span className="text-sm font-medium">全站</span>
					)}
				</div>
				<span className="shrink-0 text-xs text-muted-foreground">{group.findings.length} 项</span>
			</CardHeader>
			<CardContent className="px-0">
				{group.findings.map((finding) => (
					<FindingRow
						key={finding.id}
						finding={finding}
						selectable={canTask && finding.status === "OPEN"}
						selected={selected.has(finding.id)}
						onSelect={(on) => onToggle([finding.id], on)}
						onOpen={() => onOpen(finding.id)}
					/>
				))}
			</CardContent>
		</Card>
	);
}

interface FilterState {
	status: StatusFilter;
	severity: GeoFindingSeverity | null;
	priority: GeoPriority | null;
	group: SiteAuditRuleGroup | null;
	department: SiteAuditDepartment | null;
	search: string;
}

const INITIAL_FILTERS: FilterState = {
	status: "ACTIVE",
	severity: null,
	priority: null,
	group: null,
	department: null,
	search: "",
};

function FilterBar({ value, onChange }: { value: FilterState; onChange: (next: FilterState) => void }) {
	const set =
		<K extends keyof FilterState>(key: K) =>
		(next: FilterState[K]) =>
			onChange({ ...value, [key]: next });
	return (
		<div className="grid grid-cols-2 gap-2 md:grid-cols-6">
			<Input placeholder="按网址或规则搜索" value={value.search} onChange={(e) => set("search")(e.target.value)} />
			<SimpleSelect value={value.status} onChange={(next) => next && set("status")(next)} options={STATUS_OPTIONS} />
			<SimpleSelect
				value={value.severity}
				onChange={set("severity")}
				noneLabel="全部严重度"
				options={GEO_FINDING_SEVERITIES.map((entry) => ({
					value: entry,
					label: `${SITE_AUDIT_SEVERITY_LABELS[entry]}严重度`,
				}))}
			/>
			<SimpleSelect
				value={value.priority}
				onChange={set("priority")}
				noneLabel="全部优先级"
				options={GEO_PRIORITIES.map((entry) => ({ value: entry, label: PRIORITY_LABELS[entry] }))}
			/>
			<SimpleSelect
				value={value.group}
				onChange={set("group")}
				noneLabel="全部类别"
				options={SITE_AUDIT_RULE_GROUPS.map((entry) => ({ value: entry, label: SITE_AUDIT_RULE_GROUP_LABELS[entry] }))}
			/>
			<SimpleSelect
				value={value.department}
				onChange={set("department")}
				noneLabel="全部部门"
				options={SITE_AUDIT_DEPARTMENTS.map((entry) => ({ value: entry, label: SITE_AUDIT_DEPARTMENT_LABELS[entry] }))}
			/>
		</div>
	);
}

function SelectionBar({ count, onClear, onCreate }: { count: number; onClear: () => void; onCreate: () => void }) {
	return (
		<div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/40 px-3 py-2">
			<span className="text-sm text-muted-foreground">
				{count > 0 ? `已选择 ${count} 条待处理发现` : "勾选待处理的发现后可批量创建优化工单"}
			</span>
			<div className="flex gap-2">
				{count > 0 && (
					<Button size="sm" variant="ghost" onClick={onClear}>
						清除选择
					</Button>
				)}
				<Button size="sm" disabled={count === 0} onClick={onCreate}>
					<IconListCheck />
					批量创建工单
				</Button>
			</div>
		</div>
	);
}

function Pager({ page, total, onPage }: { page: number; total: number; onPage: (page: number) => void }) {
	const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
	return (
		<div className="flex items-center justify-between text-sm text-muted-foreground">
			<span>
				共 {total} 个页面分组，第 {page} / {totalPages} 页
			</span>
			<div className="flex gap-2">
				<Button size="sm" variant="outline" disabled={page <= 1} onClick={() => onPage(page - 1)}>
					上一页
				</Button>
				<Button size="sm" variant="outline" disabled={page >= totalPages} onClick={() => onPage(page + 1)}>
					下一页
				</Button>
			</div>
		</div>
	);
}

function toggled(current: Set<string>, ids: string[], on: boolean): Set<string> {
	const next = new Set(current);
	for (const id of ids) {
		if (on) next.add(id);
		else next.delete(id);
	}
	return next;
}

export function FindingGroups({
	organizationId,
	orgSlug,
	siteSourceId,
}: {
	organizationId: string;
	orgSlug: string;
	siteSourceId: string;
}) {
	const viewer = useGeoViewer();
	const canTask = viewer.can("task.create");
	const [filterState, setFilterState] = useState<FilterState>(INITIAL_FILTERS);
	const [page, setPage] = useState(1);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [openFinding, setOpenFinding] = useState<string | null>(null);
	const [batchOpen, setBatchOpen] = useState(false);
	const q = useDebouncedValue(filterState.search.trim(), 300);

	const filters = {
		siteSourceId,
		status: filterState.status === "ACTIVE" ? (["OPEN", "TASKED"] as GeoFindingStatus[]) : [filterState.status],
		severity: filterState.severity ?? undefined,
		priority: filterState.priority ?? undefined,
		group: filterState.group ?? undefined,
		department: filterState.department ?? undefined,
		q: q || undefined,
	};
	const groups = useQuery({
		queryKey: siteAuditKeys.groups(organizationId, filters, page),
		queryFn: () => listSiteAuditFindingGroupsFn({ data: { organizationId, filters, page, limit: PAGE_SIZE } }),
	});
	const rows = groups.data?.rows ?? [];

	return (
		<div className="flex flex-col gap-3">
			<FilterBar
				value={filterState}
				onChange={(next) => {
					setFilterState(next);
					setPage(1);
					setSelected(new Set());
				}}
			/>
			{canTask && (
				<SelectionBar
					count={selected.size}
					onClear={() => setSelected(new Set())}
					onCreate={() => setBatchOpen(true)}
				/>
			)}
			{groups.error && (
				<Alert variant="destructive">
					<AlertDescription>{errorMessage(groups.error)}</AlertDescription>
				</Alert>
			)}
			{groups.isLoading ? (
				<Skeleton className="h-64 w-full" />
			) : rows.length === 0 ? (
				<GeoEmptyState title="没有符合条件的发现" description="调整筛选条件，或在官网采集完成后运行一次审计。" />
			) : (
				<div className="flex flex-col gap-3">
					{rows.map((entry) => (
						<GroupCard
							key={entry.subject}
							group={entry}
							selected={selected}
							canTask={canTask}
							onToggle={(ids, on) => setSelected((current) => toggled(current, ids, on))}
							onOpen={setOpenFinding}
						/>
					))}
					<Pager page={page} total={groups.data?.total ?? 0} onPage={setPage} />
				</div>
			)}
			<FindingDialog
				organizationId={organizationId}
				orgSlug={orgSlug}
				findingId={openFinding}
				onClose={() => setOpenFinding(null)}
			/>
			<BatchTaskDialog
				organizationId={organizationId}
				orgSlug={orgSlug}
				findingIds={[...selected]}
				open={batchOpen}
				onOpenChange={setBatchOpen}
				onDone={() => setSelected(new Set())}
			/>
		</div>
	);
}
