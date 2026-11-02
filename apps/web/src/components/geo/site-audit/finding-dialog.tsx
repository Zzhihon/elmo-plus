import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
	GEO_PRIORITIES,
	GEO_PROMPT_STATUS_LABELS,
	type GeoPriority,
	type GeoPromptStatus,
} from "@workspace/geo-domain";
import {
	SITE_AUDIT_DEPARTMENT_LABELS,
	SITE_AUDIT_DEPARTMENTS,
	SITE_AUDIT_RULE_GROUP_LABELS,
	type SiteAuditDepartment,
	type SiteAuditRuleGroup,
} from "@workspace/geo-site-ingestion/audit/catalog";
import { Alert, AlertDescription } from "@workspace/ui/components/alert";
import { Button } from "@workspace/ui/components/button";
import { Checkbox } from "@workspace/ui/components/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@workspace/ui/components/dialog";
import { Input } from "@workspace/ui/components/input";
import { Label } from "@workspace/ui/components/label";
import { Skeleton } from "@workspace/ui/components/skeleton";
import { Textarea } from "@workspace/ui/components/textarea";
import { type ReactNode, useState } from "react";
import { GeoStatusBadge } from "@/components/geo/shell/status-badge";
import { useGeoViewer } from "@/components/geo/shell/use-geo-viewer";
import { PageVersionView } from "@/components/geo/site-pages/page-version-view";
import { errorMessage, formatDateTime } from "@/components/geo/site-pages/site-labels";
import { CreateTaskFromEvidence } from "@/components/geo/tasks/create-task-from-evidence";
import { PRIORITY_LABELS, RISK_LABELS } from "@/components/geo/tasks/labels";
import { SimpleSelect } from "@/components/geo/tasks/simple-select";
import { getSiteAuditFindingFn, listAuditPromptChoicesFn, updateSiteAuditFindingFn } from "@/server/geo/site-audit";
import { departmentLabel, FindingStatusBadge, SeverityBadge, siteAuditKeys } from "./labels";

type FindingDetail = Awaited<ReturnType<typeof getSiteAuditFindingFn>>;
type FindingPatch = Parameters<typeof updateSiteAuditFindingFn>[0]["data"]["patch"];

const HIDDEN_EVIDENCE = new Set(["summary", "url", "title", "category", "taskKind"]);

const EVIDENCE_LABELS: Record<string, string> = {
	links: "相关链接",
	pages: "相同的页面",
	samples: "示例",
	problems: "问题",
	errors: "错误",
	urls: "网址",
	crawlers: "被屏蔽的爬虫",
	h1s: "H1 内容",
	keywords: "检查的关键词",
	fieldPaths: "检查的字段",
	types: "已有结构化数据类型",
	canonicals: "canonical",
	unreachableFiles: "无法使用的站点地图",
	files: "站点地图文件",
	excerpt: "正文摘录",
	description: "description",
	detail: "详情",
};

function itemText(item: unknown): string {
	if (item === null || item === undefined) return "—";
	if (typeof item !== "object") return String(item);
	const record = item as Record<string, unknown>;
	const main = record.url ?? record.pageId ?? "";
	const rest = Object.entries(record)
		.filter(([key, value]) => key !== "url" && key !== "pageId" && value !== null && value !== undefined)
		.map(([key, value]) => `${key === "httpStatus" || key === "status" ? "HTTP " : ""}${String(value)}`);
	return [String(main), ...rest].filter(Boolean).join(" · ");
}

function EvidenceDetails({ evidence }: { evidence: Record<string, unknown> }) {
	const entries = Object.entries(evidence).filter(
		([key, value]) => !HIDDEN_EVIDENCE.has(key) && value !== null && value !== undefined && value !== "",
	);
	if (entries.length === 0) return null;
	return (
		<dl className="grid gap-2 text-sm">
			{entries.map(([key, value]) => (
				<div key={key} className="grid grid-cols-[8rem_1fr] gap-2">
					<dt className="text-muted-foreground">{EVIDENCE_LABELS[key] ?? key}</dt>
					<dd className="min-w-0 break-all">
						{Array.isArray(value) ? (
							value.length === 0 ? (
								"（无）"
							) : (
								<ul className="flex flex-col gap-0.5">
									{value.map((item, index) => (
										<li key={`${key}-${index}`}>{itemText(item)}</li>
									))}
								</ul>
							)
						) : (
							itemText(value)
						)}
					</dd>
				</div>
			))}
		</dl>
	);
}

function Section({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
	return (
		<section className="flex flex-col gap-2 border-t pt-4">
			<div className="flex items-center justify-between gap-2">
				<h3 className="text-sm font-medium">{title}</h3>
				{action}
			</div>
			{children}
		</section>
	);
}

function TargetPromptEditor({
	organizationId,
	selected,
	onSave,
	saving,
}: {
	organizationId: string;
	selected: string[];
	onSave: (ids: string[]) => void;
	saving: boolean;
}) {
	const [picked, setPicked] = useState<string[]>(selected);
	const [search, setSearch] = useState("");
	const prompts = useQuery({
		queryKey: siteAuditKeys.prompts(organizationId),
		queryFn: () => listAuditPromptChoicesFn({ data: { organizationId } }),
	});
	const needle = search.trim();
	const visible = (prompts.data ?? []).filter(
		(prompt) => !needle || prompt.question.includes(needle) || (prompt.productLine ?? "").includes(needle),
	);
	const toggle = (id: string, on: boolean) =>
		setPicked((current) => (on ? [...new Set([...current, id])] : current.filter((entry) => entry !== id)));
	return (
		<div className="flex flex-col gap-2">
			<Input placeholder="按问法或产品线搜索" value={search} onChange={(e) => setSearch(e.target.value)} />
			<div className="max-h-56 overflow-y-auto rounded-md border">
				{prompts.isLoading ? (
					<Skeleton className="h-24 w-full" />
				) : visible.length === 0 ? (
					<p className="p-3 text-sm text-muted-foreground">没有匹配的问法</p>
				) : (
					visible.map((prompt) => (
						<label
							key={prompt.id}
							htmlFor={`prompt-${prompt.id}`}
							className="flex cursor-pointer items-start gap-2 border-b px-3 py-2 text-sm last:border-b-0"
						>
							<Checkbox
								id={`prompt-${prompt.id}`}
								checked={picked.includes(prompt.id)}
								onCheckedChange={(checked) => toggle(prompt.id, checked === true)}
							/>
							<span className="flex-1">{prompt.question}</span>
							<span className="shrink-0 text-xs text-muted-foreground">
								{prompt.productLine ?? "未分产品线"} · {GEO_PROMPT_STATUS_LABELS[prompt.status as GeoPromptStatus]}
							</span>
						</label>
					))
				)}
			</div>
			<div className="flex justify-end">
				<Button size="sm" onClick={() => onSave(picked)} disabled={saving}>
					保存目标问法（{picked.length}）
				</Button>
			</div>
		</div>
	);
}

function StatusControls({
	finding,
	canTriage,
	onPatch,
	saving,
}: {
	finding: FindingDetail;
	canTriage: boolean;
	onPatch: (patch: FindingPatch) => void;
	saving: boolean;
}) {
	const [reason, setReason] = useState("");
	if (!canTriage) return null;
	if (finding.status === "OPEN") {
		return (
			<div className="flex flex-col gap-2">
				<Label htmlFor="dismiss-reason">忽略原因</Label>
				<Textarea
					id="dismiss-reason"
					rows={2}
					value={reason}
					onChange={(e) => setReason(e.target.value)}
					placeholder="例如：该页面计划下线；或该问题由模板统一处理，已在另一工单跟进"
				/>
				<div className="flex justify-end">
					<Button
						size="sm"
						variant="outline"
						disabled={saving || reason.trim().length === 0}
						onClick={() => onPatch({ status: "DISMISSED", note: reason })}
					>
						忽略此发现
					</Button>
				</div>
			</div>
		);
	}
	if (finding.status === "DISMISSED") {
		return (
			<div className="flex justify-end">
				<Button size="sm" variant="outline" disabled={saving} onClick={() => onPatch({ status: "OPEN" })}>
					恢复为待处理
				</Button>
			</div>
		);
	}
	return null;
}

interface SectionProps {
	finding: FindingDetail;
	organizationId: string;
	orgSlug: string;
	canTriage: boolean;
	saving: boolean;
	onPatch: (patch: FindingPatch) => void;
}

function HeaderLine({ finding }: { finding: FindingDetail }) {
	const group = finding.rule.group as SiteAuditRuleGroup | null;
	return (
		<>
			<div className="flex flex-wrap items-center gap-2">
				<SeverityBadge severity={finding.severity} />
				<FindingStatusBadge status={finding.status} />
				<GeoStatusBadge label={PRIORITY_LABELS[finding.priority]} />
				{group && <GeoStatusBadge label={SITE_AUDIT_RULE_GROUP_LABELS[group]} />}
				<span className="text-xs text-muted-foreground">
					规则 {finding.ruleId} v{finding.ruleVersion} · 首次发现 {formatDateTime(finding.firstSeenAt)} · 最近发现{" "}
					{formatDateTime(finding.lastSeenAt)}
				</span>
			</div>
			{finding.statusNote && (
				<Alert>
					<AlertDescription>
						{finding.status === "DISMISSED" ? "忽略原因：" : ""}
						{finding.statusNote}
						{finding.resolvedAt ? `（${formatDateTime(finding.resolvedAt)}）` : ""}
					</AlertDescription>
				</Alert>
			)}
		</>
	);
}

function PageSection({ finding, orgSlug }: Pick<SectionProps, "finding" | "orgSlug">) {
	return (
		<Section title="页面">
			{finding.page ? (
				<div className="flex flex-col gap-1 text-sm">
					<span className="break-all">{finding.page.title ?? "（无标题）"}</span>
					<span className="break-all text-muted-foreground">{finding.page.url}</span>
					<Link
						to="/app/org/$org/geo/site-pages/$id"
						params={{ org: orgSlug, id: finding.page.id }}
						className="text-sm underline"
					>
						查看页面全部版本
					</Link>
				</div>
			) : (
				<p className="text-sm text-muted-foreground">全站问题，不属于单个页面。</p>
			)}
		</Section>
	);
}

function SnapshotSection({ finding, organizationId }: Pick<SectionProps, "finding" | "organizationId">) {
	const [showSnapshot, setShowSnapshot] = useState(false);
	if (!finding.page || !finding.version) return null;
	return (
		<Section
			title="证据快照"
			action={
				<Button size="sm" variant="outline" onClick={() => setShowSnapshot((value) => !value)}>
					{showSnapshot ? "收起" : "查看快照与解析结果"}
				</Button>
			}
		>
			<p className="text-sm text-muted-foreground">
				依据页面版本 {finding.version.id.slice(0, 8)}，采集于 {formatDateTime(finding.version.fetchedAt)}，解析器{" "}
				{finding.version.parserVersion}。审计只读取已采集的快照，不会重新抓取页面。
			</p>
			{showSnapshot && (
				<PageVersionView organizationId={organizationId} pageId={finding.page.id} versionId={finding.version.id} />
			)}
		</Section>
	);
}

function RecommendationSection({ finding, canTriage, saving, onPatch }: SectionProps) {
	const [recommendation, setRecommendation] = useState(finding.recommendation ?? "");
	const restorable = finding.defaultRecommendation !== null && recommendation !== finding.defaultRecommendation;
	return (
		<Section title="建议调整项">
			{canTriage ? (
				<div className="flex flex-col gap-2">
					<Textarea rows={4} value={recommendation} onChange={(e) => setRecommendation(e.target.value)} />
					<div className="flex justify-end gap-2">
						{restorable && (
							<Button size="sm" variant="ghost" onClick={() => setRecommendation(finding.defaultRecommendation ?? "")}>
								恢复默认建议
							</Button>
						)}
						<Button
							size="sm"
							disabled={saving || recommendation.trim().length === 0 || recommendation === finding.recommendation}
							onClick={() => onPatch({ recommendation })}
						>
							保存建议
						</Button>
					</div>
				</div>
			) : (
				<p className="whitespace-pre-wrap text-sm">{finding.recommendation}</p>
			)}
			<p className="text-xs text-muted-foreground">
				平台只提供建议、待发布稿和验收清单，整改需由官网管理方在官网系统中实施，平台不会写入生产 CMS。
			</p>
		</Section>
	);
}

function AssignmentSection({ finding, canTriage, onPatch }: SectionProps) {
	return (
		<Section title="分派">
			<div className="grid gap-3 sm:grid-cols-2">
				<div className="flex flex-col gap-2">
					<Label htmlFor="finding-department">责任部门</Label>
					{canTriage ? (
						<SimpleSelect
							id="finding-department"
							value={(finding.ownerDepartment as SiteAuditDepartment | null) ?? null}
							onChange={(value) => value && onPatch({ ownerDepartment: value })}
							options={SITE_AUDIT_DEPARTMENTS.map((value) => ({ value, label: SITE_AUDIT_DEPARTMENT_LABELS[value] }))}
						/>
					) : (
						<span className="text-sm">{departmentLabel(finding.ownerDepartment)}</span>
					)}
				</div>
				<div className="flex flex-col gap-2">
					<Label htmlFor="finding-priority">优先级</Label>
					{canTriage ? (
						<SimpleSelect
							id="finding-priority"
							value={finding.priority}
							onChange={(value) => value && onPatch({ priority: value as GeoPriority })}
							options={GEO_PRIORITIES.map((value) => ({ value, label: PRIORITY_LABELS[value] }))}
						/>
					) : (
						<span className="text-sm">{PRIORITY_LABELS[finding.priority]}</span>
					)}
				</div>
			</div>
		</Section>
	);
}

function TargetPromptSection({ finding, organizationId, canTriage, saving, onPatch }: SectionProps) {
	const [editing, setEditing] = useState(false);
	return (
		<Section
			title="目标问法"
			action={
				canTriage && !editing ? (
					<Button size="sm" variant="outline" onClick={() => setEditing(true)}>
						调整
					</Button>
				) : undefined
			}
		>
			{editing ? (
				<TargetPromptEditor
					organizationId={organizationId}
					selected={finding.targetPromptIds}
					saving={saving}
					onSave={(ids) => {
						onPatch({ targetPromptIds: ids });
						setEditing(false);
					}}
				/>
			) : finding.targetPrompts.length === 0 ? (
				<p className="text-sm text-muted-foreground">没有关联问法。系统按产品线、型号和措辞推荐，可人工调整。</p>
			) : (
				<ul className="flex flex-col gap-1 text-sm">
					{finding.targetPrompts.map((prompt) => (
						<li key={prompt.id}>
							{prompt.question}
							<span className="ml-2 text-xs text-muted-foreground">{prompt.productLine ?? ""}</span>
						</li>
					))}
				</ul>
			)}
		</Section>
	);
}

const TECHNICAL_RULES = new Set(["product.param_source_missing", "product.selection_missing"]);

function TaskSection({ finding, organizationId, orgSlug }: SectionProps) {
	const queryClient = useQueryClient();
	const technical = TECHNICAL_RULES.has(finding.ruleId);
	return (
		<Section title="工单">
			{finding.task && (
				<Link
					to="/app/org/$org/geo/tasks/$id"
					params={{ org: orgSlug, id: finding.task.id }}
					className="text-sm underline"
				>
					{finding.status === "TASKED" ? "已关联工单：" : "曾关联工单："}
					{finding.task.title}
				</Link>
			)}
			{finding.status === "OPEN" && (
				<div className="flex flex-wrap items-center gap-2">
					<CreateTaskFromEvidence
						sourceKind="FINDING"
						sourceRef={`finding:${finding.id}`}
						evidence={{ findingIds: [finding.id] }}
						defaultTitle={`${finding.rule.title}：${finding.page?.title ?? finding.page?.url ?? "全站"}`}
						defaultKind={finding.taskKind}
						defaultPriority={finding.priority}
						defaultRiskLevel={technical ? "HIGH" : "NORMAL"}
						promptId={finding.targetPromptIds[0] ?? null}
						recommendedAction={finding.recommendation ?? undefined}
						variant="default"
						onCreated={() => queryClient.invalidateQueries({ queryKey: siteAuditKeys.all(organizationId) })}
					/>
					{technical && <span className="text-xs text-muted-foreground">涉及技术内容，默认{RISK_LABELS.HIGH}</span>}
				</div>
			)}
		</Section>
	);
}

function FindingBody({
	finding,
	organizationId,
	orgSlug,
}: {
	finding: FindingDetail;
	organizationId: string;
	orgSlug: string;
}) {
	const viewer = useGeoViewer();
	const queryClient = useQueryClient();
	const canTriage = viewer.can("site_audit.triage");
	const update = useMutation({
		mutationFn: (patch: FindingPatch) =>
			updateSiteAuditFindingFn({ data: { organizationId, findingId: finding.id, patch } }),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: siteAuditKeys.all(organizationId) }),
	});
	const props: SectionProps = {
		finding,
		organizationId,
		orgSlug,
		canTriage,
		saving: update.isPending,
		onPatch: (patch) => update.mutate(patch),
	};
	const triageable = canTriage && (finding.status === "OPEN" || finding.status === "DISMISSED");

	return (
		<div className="flex flex-col gap-4">
			<HeaderLine finding={finding} />
			<PageSection finding={finding} orgSlug={orgSlug} />
			<Section title="问题">
				<p className="text-sm">{finding.summary}</p>
				<p className="text-sm text-muted-foreground">{finding.rule.description}</p>
				<EvidenceDetails evidence={finding.evidence} />
			</Section>
			<SnapshotSection finding={finding} organizationId={organizationId} />
			<RecommendationSection {...props} />
			<AssignmentSection {...props} />
			<TargetPromptSection {...props} />
			<TaskSection {...props} />
			{triageable && (
				<Section title="状态">
					<StatusControls finding={finding} canTriage={canTriage} saving={update.isPending} onPatch={props.onPatch} />
				</Section>
			)}
			{update.error && (
				<Alert variant="destructive">
					<AlertDescription>{errorMessage(update.error)}</AlertDescription>
				</Alert>
			)}
		</div>
	);
}

export function FindingDialog({
	organizationId,
	orgSlug,
	findingId,
	onClose,
}: {
	organizationId: string;
	orgSlug: string;
	findingId: string | null;
	onClose: () => void;
}) {
	const detail = useQuery({
		queryKey: siteAuditKeys.finding(organizationId, findingId ?? ""),
		queryFn: () => getSiteAuditFindingFn({ data: { organizationId, findingId: findingId as string } }),
		enabled: findingId !== null,
	});
	return (
		<Dialog open={findingId !== null} onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
				<DialogHeader>
					<DialogTitle>{detail.data?.rule.title ?? "审计发现"}</DialogTitle>
					<DialogDescription>
						“可被抓取”与“被 AI 检索、引用或推荐”不是同一指标，修复后仍需按目标问法复测。
					</DialogDescription>
				</DialogHeader>
				{detail.isLoading || !detail.data ? (
					detail.error ? (
						<Alert variant="destructive">
							<AlertDescription>{errorMessage(detail.error)}</AlertDescription>
						</Alert>
					) : (
						<Skeleton className="h-96 w-full" />
					)
				) : (
					<FindingBody key={detail.data.id} finding={detail.data} organizationId={organizationId} orgSlug={orgSlug} />
				)}
			</DialogContent>
		</Dialog>
	);
}
