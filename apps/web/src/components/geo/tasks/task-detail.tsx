import { Link } from "@tanstack/react-router";
import {
	GEO_ASSERTION_STATUS_LABELS,
	GEO_BATCH_STATUS_LABELS,
	GEO_PLATFORM_LABELS,
	GEO_TASK_STATE_LABELS,
	type GeoAssertionStatus,
	type GeoBatchStatus,
	type GeoContentApprovalState,
	type GeoPlatform,
	type GeoTaskState,
	launchPlanProblem,
	requiresLaunchPlan,
} from "@workspace/geo-domain";
import { Alert, AlertDescription, AlertTitle } from "@workspace/ui/components/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@workspace/ui/components/card";
import type { ReactNode } from "react";
import { GeoBatchComparison } from "@/components/geo/insights/batch-comparison";
import { GeoEmptyState } from "@/components/geo/shell/empty-state";
import { GeoStatusBadge, GeoTaskStateBadge } from "@/components/geo/shell/status-badge";
import { useGeoViewer } from "@/components/geo/shell/use-geo-viewer";
import type { TaskDetail } from "@/server/geo/tasks-core";
import {
	EVENT_ACTION_LABELS,
	formatDateTime,
	PRIORITY_LABELS,
	RISK_LABELS,
	SOURCE_KIND_LABELS,
	TASK_KIND_LABELS,
} from "./labels";
import { GeoTaskActions } from "./task-actions";
import { GeoTaskEditDialog } from "./task-edit-dialog";

const CONTENT_STATE_LABELS: Record<GeoContentApprovalState, string> = {
	DRAFT: "草稿",
	PENDING_TECH_REVIEW: "待技术审核",
	PENDING_MARKETING_REVIEW: "待市场审核",
	APPROVED: "已审核",
	REJECTED: "已驳回",
	PUBLISHED: "已发布",
};

function Field({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="space-y-1">
			<dt className="text-xs text-muted-foreground">{label}</dt>
			<dd className="whitespace-pre-wrap break-words text-sm">{children ?? "—"}</dd>
		</div>
	);
}

function Section({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
	return (
		<Card>
			<CardHeader className="flex flex-row items-center justify-between gap-2">
				<CardTitle className="text-base">{title}</CardTitle>
				{actions}
			</CardHeader>
			<CardContent>{children}</CardContent>
		</Card>
	);
}

function name(detail: TaskDetail, id: string | null): string {
	if (!id) return "—";
	return detail.names[id] ?? id;
}

function BatchLine({ batch }: { batch: TaskDetail["beforeBatch"] }) {
	if (!batch) return <>未关联</>;
	return (
		<span>
			{batch.promptSetName} v{batch.promptSetVersion} · {formatDateTime(batch.createdAt)} ·{" "}
			{GEO_BATCH_STATUS_LABELS[batch.status as GeoBatchStatus]} · 有效 {batch.validCount}/{batch.plannedCount}
		</span>
	);
}

function EvidenceList({ detail, orgSlug }: { detail: TaskDetail; orgSlug: string }) {
	if (detail.evidence.length === 0) {
		return <GeoEmptyState title="没有关联诊断证据" description="手动创建的工单可以在描述中说明依据。" />;
	}
	return (
		<ul className="divide-y">
			{detail.evidence.map((item) => (
				<li key={item.id} className="py-3 text-sm">
					{item.observationId && (
						<div className="flex flex-col gap-1">
							<div className="flex items-center gap-2">
								<GeoStatusBadge label="采样证据" tone="info" />
								<span className="text-muted-foreground">
									{GEO_PLATFORM_LABELS[item.observationPlatform as GeoPlatform] ?? item.observationPlatform} ·{" "}
									{formatDateTime(item.observationSampledAt)}
								</span>
							</div>
							<Link
								to="/app/org/$org/geo/observations/$id"
								params={{ org: orgSlug, id: item.observationId }}
								className="hover:underline"
							>
								{item.observationQuestion ?? "查看证据"}
							</Link>
						</div>
					)}
					{item.findingId && (
						<div className="flex flex-col gap-1">
							<div className="flex items-center gap-2">
								<GeoStatusBadge label="站点审计发现" tone="warning" />
								<span className="text-muted-foreground">
									{item.findingRuleId} · {item.findingSeverity}
								</span>
							</div>
							<span className="break-all">{item.findingPageUrl ?? "站点级问题"}</span>
							{item.findingRecommendation && (
								<span className="text-muted-foreground">{item.findingRecommendation}</span>
							)}
						</div>
					)}
					{item.assertionId && (
						<div className="flex flex-col gap-1">
							<div className="flex items-center gap-2">
								<GeoStatusBadge label="知识断言" tone="neutral" />
								{item.assertionStatus && (
									<span className="text-muted-foreground">
										{GEO_ASSERTION_STATUS_LABELS[item.assertionStatus as GeoAssertionStatus]}
									</span>
								)}
							</div>
							<span>{item.assertionClaim}</span>
						</div>
					)}
				</li>
			))}
		</ul>
	);
}

function RetestComparison({ detail }: { detail: TaskDetail }) {
	const viewer = useGeoViewer();
	const { beforeBatchId, afterBatchId, promptId } = detail.task;
	if (!beforeBatchId || !afterBatchId) {
		return (
			<GeoEmptyState title="尚未关联前后批次" description="关联基线批次和复测批次后，这里按平台与采样方式对比。" />
		);
	}
	if (!viewer.can("metric.read")) {
		return <GeoEmptyState title="没有查看指标的权限" description="复测对比使用洞察指标，需要指标查看权限。" />;
	}
	return (
		<GeoBatchComparison
			beforeBatchId={beforeBatchId}
			afterBatchId={afterBatchId}
			promptId={promptId}
			comparison={detail.comparison}
		/>
	);
}

function Timeline({ detail }: { detail: TaskDetail }) {
	return (
		<ol className="space-y-4">
			{[...detail.events].reverse().map((event) => (
				<li key={event.id} className="border-l-2 pl-3 text-sm">
					<div className="flex flex-wrap items-center gap-2">
						<span className="font-medium">{EVENT_ACTION_LABELS[event.action] ?? event.action}</span>
						{event.fromState && event.fromState !== event.toState && (
							<span className="text-muted-foreground">
								{GEO_TASK_STATE_LABELS[event.fromState as GeoTaskState]} →{" "}
								{GEO_TASK_STATE_LABELS[event.toState as GeoTaskState]}
							</span>
						)}
					</div>
					<div className="text-xs text-muted-foreground">
						{name(detail, event.actorId)} · {formatDateTime(event.createdAt)}
					</div>
					{event.comment && <p className="mt-1 whitespace-pre-wrap">{event.comment}</p>}
				</li>
			))}
		</ol>
	);
}

function TaskBanners({ detail }: { detail: TaskDetail }) {
	const { task } = detail;
	const lastRejection = [...detail.events].reverse().find((event) => event.action === "REJECT");
	return (
		<>
			{task.state === "REJECTED" && lastRejection && (
				<Alert variant="destructive">
					<AlertTitle>已驳回：{name(detail, lastRejection.actorId)}</AlertTitle>
					<AlertDescription className="whitespace-pre-wrap">{lastRejection.comment}</AlertDescription>
				</Alert>
			)}
			{task.state === "PAUSED" && task.pausedFrom && (
				<Alert>
					<AlertDescription>工单已暂停，恢复后回到「{GEO_TASK_STATE_LABELS[task.pausedFrom]}」。</AlertDescription>
				</Alert>
			)}
			{(task.state === "PUBLISHED" || task.state === "PENDING_RETEST") && (
				<Alert>
					<AlertTitle>已发布不等于有效</AlertTitle>
					<AlertDescription>
						需要在发布后完成同一问法集的复测采样，对比前后批次，再由运营人员确认验证结论。
					</AlertDescription>
				</Alert>
			)}
		</>
	);
}

function TaskSidebar({ detail, orgSlug }: { detail: TaskDetail; orgSlug: string }) {
	const viewer = useGeoViewer();
	const { task } = detail;
	const planProblem = launchPlanProblem(task);
	const showPlan = requiresLaunchPlan(task.kind, task.riskLevel) || task.launchApprovalRef || task.rollbackPlan;
	const unapprovedContent = detail.content.filter((item) => !["APPROVED", "PUBLISHED"].includes(item.approvalState));
	return (
		<div className="flex flex-col gap-4">
			{showPlan && (
				<Section title="上线计划">
					{planProblem && (
						<Alert variant="destructive" className="mb-3">
							<AlertDescription>{planProblem}</AlertDescription>
						</Alert>
					)}
					<dl className="space-y-3">
						<Field label="上线审批编号">{task.launchApprovalRef}</Field>
						<Field label="备份方案">{task.backupPlan}</Field>
						<Field label="回滚计划">{task.rollbackPlan}</Field>
					</dl>
				</Section>
			)}

			<Section title="发布凭证">
				{task.publishedUrl ? (
					<dl className="space-y-3">
						<Field label="发布 URL">
							<a href={task.publishedUrl} target="_blank" rel="noopener noreferrer" className="break-all underline">
								{task.publishedUrl}
							</a>
						</Field>
						<Field label="发布时间">{formatDateTime(task.publishedAt)}</Field>
						<Field label="凭证">{task.proof?.note}</Field>
						{task.proof?.url && (
							<Field label="凭证链接">
								<a href={task.proof.url} target="_blank" rel="noopener noreferrer" className="break-all underline">
									{task.proof.url}
								</a>
							</Field>
						)}
						{task.proof && (
							<Field label="登记人">
								{name(detail, task.proof.recordedBy)} · {formatDateTime(task.proof.recordedAt)}
							</Field>
						)}
					</dl>
				) : (
					<p className="text-sm text-muted-foreground">尚未登记发布。</p>
				)}
			</Section>

			<Section title="关联内容">
				{detail.content.length === 0 ? (
					<p className="text-sm text-muted-foreground">没有关联的内容稿件。</p>
				) : (
					<ul className="space-y-2 text-sm">
						{detail.content.map((item) => (
							<li key={item.id} className="flex items-center justify-between gap-2">
								<span>
									{item.title} <span className="text-muted-foreground">v{item.currentVersion}</span>
								</span>
								<GeoStatusBadge
									label={CONTENT_STATE_LABELS[item.approvalState as GeoContentApprovalState] ?? item.approvalState}
									tone={["APPROVED", "PUBLISHED"].includes(item.approvalState) ? "success" : "warning"}
								/>
							</li>
						))}
					</ul>
				)}
				{unapprovedContent.length > 0 && (
					<p className="mt-3 text-xs text-muted-foreground">关联内容全部审核通过后才能登记发布。</p>
				)}
			</Section>

			<Section
				title="操作记录"
				actions={
					viewer.can("audit.read") ? (
						<Link
							to="/app/org/$org/geo/settings"
							params={{ org: orgSlug }}
							search={{ tab: "audit", entityId: task.id }}
							className="text-sm hover:underline"
						>
							审计日志
						</Link>
					) : undefined
				}
			>
				<Timeline detail={detail} />
			</Section>
		</div>
	);
}

export function GeoTaskDetailView({ detail, orgSlug }: { detail: TaskDetail; orgSlug: string }) {
	const { task } = detail;

	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div className="flex flex-wrap items-center gap-2">
					<GeoTaskStateBadge state={task.state} />
					<GeoStatusBadge label={PRIORITY_LABELS[task.priority]} tone={task.priority === "P0" ? "danger" : "neutral"} />
					<GeoStatusBadge
						label={RISK_LABELS[task.riskLevel]}
						tone={task.riskLevel === "HIGH" ? "warning" : "neutral"}
					/>
					<span className="text-sm text-muted-foreground">{TASK_KIND_LABELS[task.kind]}</span>
				</div>
				<div className="flex flex-wrap gap-2">
					<GeoTaskEditDialog key={task.updatedAt} task={task} />
					<GeoTaskActions task={task} />
				</div>
			</div>

			<TaskBanners detail={detail} />

			<div className="grid gap-4 lg:grid-cols-3">
				<div className="flex flex-col gap-4 lg:col-span-2">
					<Section title="基本信息">
						<dl className="grid gap-4 sm:grid-cols-2">
							<Field label="责任人">{task.ownerId ? name(detail, task.ownerId) : "未指派"}</Field>
							<Field label="创建人">
								{name(detail, task.createdBy)} · {formatDateTime(task.createdAt)}
							</Field>
							<Field label="来源">
								{SOURCE_KIND_LABELS[task.sourceKind]}
								{task.sourceRef ? ` · ${task.sourceRef}` : ""}
							</Field>
							<Field label="目标问法">{detail.prompt?.question}</Field>
							<Field label="建议动作">{task.recommendedAction}</Field>
							<Field label="预期指标">{task.expectedMetric}</Field>
						</dl>
					</Section>

					<Section title="诊断证据">
						<EvidenceList detail={detail} orgSlug={orgSlug} />
					</Section>

					<Section
						title="复测对比"
						actions={
							<Link to="/app/org/$org/geo/insights" params={{ org: orgSlug }} className="text-sm hover:underline">
								在洞察中查看
							</Link>
						}
					>
						<dl className="mb-4 grid gap-4 sm:grid-cols-2">
							<Field label="基线批次（发布前）">
								<BatchLine batch={detail.beforeBatch} />
							</Field>
							<Field label="复测批次（发布后）">
								<BatchLine batch={detail.afterBatch} />
							</Field>
							<Field label="复测轮次">{detail.retestRounds}</Field>
						</dl>
						<RetestComparison detail={detail} />
					</Section>
				</div>

				<TaskSidebar detail={detail} orgSlug={orgSlug} />
			</div>
		</div>
	);
}
