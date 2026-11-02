import { IconPencil } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import {
	GEO_PRIORITIES,
	type GeoPriority,
	type GeoRiskLevel,
	type GeoTaskState,
	requiresLaunchPlan,
} from "@workspace/geo-domain";
import { Alert, AlertDescription } from "@workspace/ui/components/alert";
import { Button } from "@workspace/ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@workspace/ui/components/dialog";
import { Input } from "@workspace/ui/components/input";
import { Label } from "@workspace/ui/components/label";
import { Textarea } from "@workspace/ui/components/textarea";
import { useState } from "react";
import { useGeoViewer } from "@/components/geo/shell/use-geo-viewer";
import { updateGeoTaskFn } from "@/server/geo/tasks";
import type { TaskDetail, UpdateTaskInput } from "@/server/geo/tasks-core";
import { errorMessage, PRIORITY_LABELS, RISK_LABELS } from "./labels";
import { geoTaskKeys, useGeoTaskChoices } from "./queries";
import { SimpleSelect } from "./simple-select";

type Task = TaskDetail["task"];

const PLAN_LOCKED: readonly GeoTaskState[] = ["PENDING_PUBLISH", "PUBLISHED", "PENDING_RETEST"];
const OWNER_EDITABLE: readonly GeoTaskState[] = ["PENDING_ASSIGNMENT", "IN_PROGRESS", "REJECTED", "PAUSED"];
const AFTER_PUBLISH: readonly GeoTaskState[] = ["PUBLISHED", "PENDING_RETEST", "VERIFIED", "CANCELLED"];

export function GeoTaskEditDialog({ task }: { task: Task }) {
	const viewer = useGeoViewer();
	const queryClient = useQueryClient();
	const [open, setOpen] = useState(false);
	const choices = useGeoTaskChoices(task.organizationId, open);
	const [form, setForm] = useState({
		title: task.title,
		priority: task.priority as GeoPriority,
		riskLevel: task.riskLevel as GeoRiskLevel,
		ownerId: task.ownerId,
		promptId: task.promptId,
		recommendedAction: task.recommendedAction ?? "",
		expectedMetric: task.expectedMetric ?? "",
		launchApprovalRef: task.launchApprovalRef ?? "",
		backupPlan: task.backupPlan ?? "",
		rollbackPlan: task.rollbackPlan ?? "",
		beforeBatchId: task.beforeBatchId,
		afterBatchId: task.afterBatchId,
	});
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
		setForm((prev) => ({ ...prev, [key]: value }));

	if (!viewer.can("task.transition") || ["VERIFIED", "CANCELLED"].includes(task.state)) return null;

	const planLocked = PLAN_LOCKED.includes(task.state);
	const needsPlan = requiresLaunchPlan(task.kind, form.riskLevel);
	const batchOptions = (choices.data?.batches ?? []).map((batch) => ({
		value: batch.id,
		label: `${batch.promptSetName} v${batch.promptSetVersion} · ${new Date(batch.createdAt).toLocaleDateString("zh-CN")}`,
	}));

	async function submit(e: React.FormEvent) {
		e.preventDefault();
		setSaving(true);
		setError(null);
		const input: UpdateTaskInput = {
			title: form.title,
			priority: form.priority,
			riskLevel: form.riskLevel,
			promptId: form.promptId,
			recommendedAction: form.recommendedAction || null,
			expectedMetric: form.expectedMetric || null,
			...(OWNER_EDITABLE.includes(task.state) && { ownerId: form.ownerId }),
			...(!planLocked && {
				launchApprovalRef: form.launchApprovalRef || null,
				backupPlan: form.backupPlan || null,
				rollbackPlan: form.rollbackPlan || null,
			}),
			...(!AFTER_PUBLISH.includes(task.state) && { beforeBatchId: form.beforeBatchId }),
			...(task.state === "PENDING_RETEST" && { afterBatchId: form.afterBatchId }),
		};
		try {
			await updateGeoTaskFn({ data: { organizationId: viewer.organizationId, taskId: task.id, input } });
			await queryClient.invalidateQueries({ queryKey: geoTaskKeys.all(viewer.organizationId) });
			setOpen(false);
		} catch (err) {
			setError(errorMessage(err));
		} finally {
			setSaving(false);
		}
	}

	return (
		<>
			<Button size="sm" variant="outline" onClick={() => setOpen(true)}>
				<IconPencil />
				编辑工单
			</Button>
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
					<DialogHeader>
						<DialogTitle>编辑工单</DialogTitle>
						<DialogDescription>修改会写入工单记录和审计日志。风险等级只能调高。</DialogDescription>
					</DialogHeader>
					<form onSubmit={submit} className="space-y-4">
						<div className="space-y-2">
							<Label htmlFor="edit-title">标题</Label>
							<Input id="edit-title" value={form.title} onChange={(e) => set("title", e.target.value)} required />
						</div>
						<div className="grid grid-cols-2 gap-3">
							<div className="space-y-2">
								<Label htmlFor="edit-priority">优先级</Label>
								<SimpleSelect
									id="edit-priority"
									value={form.priority}
									onChange={(value) => value && set("priority", value)}
									options={GEO_PRIORITIES.map((value) => ({ value, label: PRIORITY_LABELS[value] }))}
								/>
							</div>
							<div className="space-y-2">
								<Label htmlFor="edit-risk">风险等级</Label>
								<SimpleSelect
									id="edit-risk"
									value={form.riskLevel}
									onChange={(value) => value && set("riskLevel", value)}
									disabled={task.riskLevel === "HIGH"}
									options={(["NORMAL", "HIGH"] as const).map((value) => ({ value, label: RISK_LABELS[value] }))}
								/>
							</div>
						</div>
						<div className="grid grid-cols-2 gap-3">
							<div className="space-y-2">
								<Label htmlFor="edit-owner">责任人</Label>
								<SimpleSelect
									id="edit-owner"
									value={form.ownerId}
									onChange={(value) => set("ownerId", value)}
									disabled={!OWNER_EDITABLE.includes(task.state)}
									noneLabel="未指派"
									options={(choices.data?.assignees ?? []).map((person) => ({ value: person.id, label: person.name }))}
								/>
							</div>
							<div className="space-y-2">
								<Label htmlFor="edit-prompt">目标问法</Label>
								<SimpleSelect
									id="edit-prompt"
									value={form.promptId}
									onChange={(value) => set("promptId", value)}
									noneLabel="不关联"
									options={(choices.data?.prompts ?? []).map((prompt) => ({
										value: prompt.id,
										label: prompt.question,
									}))}
								/>
							</div>
						</div>
						<div className="space-y-2">
							<Label htmlFor="edit-action">建议动作</Label>
							<Textarea
								id="edit-action"
								value={form.recommendedAction}
								onChange={(e) => set("recommendedAction", e.target.value)}
								rows={3}
							/>
						</div>
						<div className="space-y-2">
							<Label htmlFor="edit-metric">预期指标</Label>
							<Input
								id="edit-metric"
								value={form.expectedMetric}
								onChange={(e) => set("expectedMetric", e.target.value)}
							/>
						</div>
						<fieldset className="space-y-3 rounded-md border p-3" disabled={planLocked}>
							<legend className="px-1 text-sm font-medium">上线计划{needsPlan ? "（高风险官网改造必填）" : ""}</legend>
							{planLocked && <p className="text-xs text-muted-foreground">上线计划已通过审核，不能再修改。</p>}
							<div className="space-y-2">
								<Label htmlFor="edit-approval">上线审批编号</Label>
								<Input
									id="edit-approval"
									value={form.launchApprovalRef}
									onChange={(e) => set("launchApprovalRef", e.target.value)}
								/>
							</div>
							<div className="space-y-2">
								<Label htmlFor="edit-backup">备份方案</Label>
								<Textarea
									id="edit-backup"
									value={form.backupPlan}
									onChange={(e) => set("backupPlan", e.target.value)}
									rows={2}
								/>
							</div>
							<div className="space-y-2">
								<Label htmlFor="edit-rollback">回滚计划</Label>
								<Textarea
									id="edit-rollback"
									value={form.rollbackPlan}
									onChange={(e) => set("rollbackPlan", e.target.value)}
									rows={2}
								/>
							</div>
						</fieldset>
						<div className="grid grid-cols-2 gap-3">
							<div className="space-y-2">
								<Label htmlFor="edit-before">基线批次</Label>
								<SimpleSelect
									id="edit-before"
									value={form.beforeBatchId}
									onChange={(value) => set("beforeBatchId", value)}
									disabled={AFTER_PUBLISH.includes(task.state)}
									noneLabel="不关联"
									options={batchOptions}
								/>
							</div>
							<div className="space-y-2">
								<Label htmlFor="edit-after">复测批次</Label>
								<SimpleSelect
									id="edit-after"
									value={form.afterBatchId}
									onChange={(value) => set("afterBatchId", value)}
									disabled={task.state !== "PENDING_RETEST"}
									noneLabel="不关联"
									options={batchOptions}
								/>
							</div>
						</div>
						{error && (
							<Alert variant="destructive">
								<AlertDescription>{error}</AlertDescription>
							</Alert>
						)}
						<DialogFooter>
							<Button type="button" variant="outline" onClick={() => setOpen(false)}>
								取消
							</Button>
							<Button type="submit" disabled={saving}>
								{saving ? "保存中…" : "保存"}
							</Button>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>
		</>
	);
}
