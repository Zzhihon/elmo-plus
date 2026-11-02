import { useQueryClient } from "@tanstack/react-query";
import {
	GEO_TASK_ACTIONS,
	GEO_TASK_STATE_LABELS,
	type GeoRole,
	type GeoTaskAction,
	launchPlanProblem,
	taskTransition,
} from "@workspace/geo-domain";
import { Alert, AlertDescription, AlertTitle } from "@workspace/ui/components/alert";
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
import { transitionGeoTaskFn } from "@/server/geo/tasks";
import type { TaskDetail } from "@/server/geo/tasks-core";
import { ACTION_LABELS, errorMessage } from "./labels";
import { geoTaskKeys, useGeoTaskChoices } from "./queries";
import { SimpleSelect } from "./simple-select";

const COMMENT_REQUIRED: readonly GeoTaskAction[] = ["REJECT", "PAUSE", "CANCEL", "REOPEN"];
const DESTRUCTIVE: readonly GeoTaskAction[] = ["REJECT", "CANCEL"];

type Task = TaskDetail["task"];

/** Shown when the state machine would allow the action for this person; the server re-checks everything. */
export function availableActions(task: Task, viewer: { actorId: string; roles: readonly GeoRole[] }): GeoTaskAction[] {
	return GEO_TASK_ACTIONS.filter((action) => {
		const result = taskTransition({
			task: {
				state: task.state,
				kind: task.kind,
				riskLevel: task.riskLevel,
				authorId: task.createdBy,
				ownerId: task.ownerId,
				pausedFrom: task.pausedFrom,
			},
			action,
			actor: { kind: "principal", id: viewer.actorId, roles: viewer.roles },
		});
		return result.ok || result.code === "VALIDATION_ERROR" || result.code === "EVIDENCE_REQUIRED";
	});
}

function toLocalInput(date: Date): string {
	const offset = date.getTimezoneOffset() * 60_000;
	return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

interface ActionFields {
	comment: string;
	ownerId: string | null;
	publishedUrl: string;
	publishedAt: string;
	proofNote: string;
	proofUrl: string;
	beforeBatchId: string | null;
	afterBatchId: string | null;
}

type SetField = <K extends keyof ActionFields>(key: K, value: ActionFields[K]) => void;

function isIncomplete(action: GeoTaskAction, fields: ActionFields): boolean {
	if (COMMENT_REQUIRED.includes(action) && fields.comment.trim().length === 0) return true;
	switch (action) {
		case "ASSIGN":
			return !fields.ownerId;
		case "PUBLISH":
			return !fields.publishedUrl.trim() || !fields.publishedAt || !fields.proofNote.trim();
		case "VERIFY":
			return !fields.beforeBatchId || !fields.afterBatchId;
		default:
			return false;
	}
}

/** Sends only what the action uses, so a stale field from another form never reaches the server. */
function transitionInput(action: GeoTaskAction, fields: ActionFields) {
	const base = { action, comment: fields.comment || null };
	switch (action) {
		case "ASSIGN":
			return { ...base, ownerId: fields.ownerId };
		case "PUBLISH":
			return {
				...base,
				publishedUrl: fields.publishedUrl,
				publishedAt: fields.publishedAt ? new Date(fields.publishedAt).toISOString() : null,
				proofNote: fields.proofNote,
				proofUrl: fields.proofUrl || null,
			};
		case "VERIFY":
			return { ...base, beforeBatchId: fields.beforeBatchId, afterBatchId: fields.afterBatchId };
		default:
			return base;
	}
}

function PublishFields({ fields, set }: { fields: ActionFields; set: SetField }) {
	return (
		<>
			<Alert>
				<AlertDescription>
					登记发布只说明内容已上线，不代表优化有效。是否有效要在复测后对比前后批次再确认。
				</AlertDescription>
			</Alert>
			<div className="space-y-2">
				<Label htmlFor="publish-url">实际发布 URL</Label>
				<Input
					id="publish-url"
					type="url"
					value={fields.publishedUrl}
					onChange={(e) => set("publishedUrl", e.target.value)}
					placeholder="https://"
					required
				/>
			</div>
			<div className="space-y-2">
				<Label htmlFor="publish-at">发布时间</Label>
				<Input
					id="publish-at"
					type="datetime-local"
					value={fields.publishedAt}
					onChange={(e) => set("publishedAt", e.target.value)}
					required
				/>
			</div>
			<div className="space-y-2">
				<Label htmlFor="proof-note">可验证凭证</Label>
				<Textarea
					id="proof-note"
					value={fields.proofNote}
					onChange={(e) => set("proofNote", e.target.value)}
					rows={3}
					placeholder="例如：CMS 发布单号、审批记录编号、页面存档说明"
					required
				/>
			</div>
			<div className="space-y-2">
				<Label htmlFor="proof-url">凭证链接（可选）</Label>
				<Input
					id="proof-url"
					type="url"
					value={fields.proofUrl}
					onChange={(e) => set("proofUrl", e.target.value)}
					placeholder="页面存档或截图所在地址"
				/>
			</div>
		</>
	);
}

function VerifyFields({
	fields,
	set,
	options,
}: {
	fields: ActionFields;
	set: SetField;
	options: { value: string; label: string }[];
}) {
	return (
		<>
			<div className="space-y-2">
				<Label htmlFor="verify-before">基线批次（发布前）</Label>
				<SimpleSelect
					id="verify-before"
					value={fields.beforeBatchId}
					onChange={(value) => set("beforeBatchId", value)}
					options={options}
				/>
			</div>
			<div className="space-y-2">
				<Label htmlFor="verify-after">复测批次（发布后）</Label>
				<SimpleSelect
					id="verify-after"
					value={fields.afterBatchId}
					onChange={(value) => set("afterBatchId", value)}
					options={options}
				/>
			</div>
			<p className="text-xs text-muted-foreground">
				两个批次必须使用同一问法集版本。请先查看复测对比，少量样本的变化只能视为观察。
			</p>
		</>
	);
}

function ActionDialog({ task, action, onClose }: { task: Task; action: GeoTaskAction; onClose: () => void }) {
	const viewer = useGeoViewer();
	const queryClient = useQueryClient();
	const choices = useGeoTaskChoices(task.organizationId, action === "ASSIGN" || action === "VERIFY");
	const [fields, setFields] = useState<ActionFields>({
		comment: "",
		ownerId: task.ownerId,
		publishedUrl: "",
		publishedAt: toLocalInput(new Date()),
		proofNote: "",
		proofUrl: "",
		beforeBatchId: task.beforeBatchId,
		afterBatchId: task.afterBatchId,
	});
	const set: SetField = (key, value) => setFields((prev) => ({ ...prev, [key]: value }));
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const plan = action === "APPROVE_MARKETING" || action === "PUBLISH" ? launchPlanProblem(task) : null;
	const batchOptions = (choices.data?.batches ?? []).map((batch) => ({
		value: batch.id,
		label: `${batch.promptSetName} v${batch.promptSetVersion} · ${new Date(batch.createdAt).toLocaleDateString("zh-CN")} · 有效 ${batch.validCount}/${batch.plannedCount}`,
	}));
	const commentRequired = COMMENT_REQUIRED.includes(action);

	async function submit(e: React.FormEvent) {
		e.preventDefault();
		setSaving(true);
		setError(null);
		try {
			await transitionGeoTaskFn({
				data: { organizationId: viewer.organizationId, taskId: task.id, input: transitionInput(action, fields) },
			});
			await queryClient.invalidateQueries({ queryKey: geoTaskKeys.all(viewer.organizationId) });
			onClose();
		} catch (err) {
			setError(errorMessage(err));
		} finally {
			setSaving(false);
		}
	}

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>{ACTION_LABELS[action]}</DialogTitle>
					<DialogDescription>
						当前状态：{GEO_TASK_STATE_LABELS[task.state]}。操作会写入工单记录和审计日志。
					</DialogDescription>
				</DialogHeader>
				<form onSubmit={submit} className="space-y-4">
					{plan && (
						<Alert variant="destructive">
							<AlertTitle>上线计划不完整</AlertTitle>
							<AlertDescription>{plan}。请先在「编辑工单」中补充。</AlertDescription>
						</Alert>
					)}
					{action === "ASSIGN" && (
						<div className="space-y-2">
							<Label htmlFor="action-owner">责任人</Label>
							<SimpleSelect
								id="action-owner"
								value={fields.ownerId}
								onChange={(value) => set("ownerId", value)}
								placeholder="选择责任人"
								options={(choices.data?.assignees ?? []).map((person) => ({ value: person.id, label: person.name }))}
							/>
						</div>
					)}
					{action === "PUBLISH" && <PublishFields fields={fields} set={set} />}
					{action === "VERIFY" && <VerifyFields fields={fields} set={set} options={batchOptions} />}
					<div className="space-y-2">
						<Label htmlFor="action-comment">{commentRequired ? "意见（必填）" : "意见"}</Label>
						<Textarea
							id="action-comment"
							value={fields.comment}
							onChange={(e) => set("comment", e.target.value)}
							rows={3}
							required={commentRequired}
						/>
					</div>
					{error && (
						<Alert variant="destructive">
							<AlertDescription>{error}</AlertDescription>
						</Alert>
					)}
					<DialogFooter>
						<Button type="button" variant="outline" onClick={onClose}>
							取消
						</Button>
						<Button
							type="submit"
							variant={DESTRUCTIVE.includes(action) ? "destructive" : "default"}
							disabled={saving || isIncomplete(action, fields) || Boolean(plan)}
						>
							{saving ? "提交中…" : ACTION_LABELS[action]}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

export function GeoTaskActions({ task }: { task: Task }) {
	const viewer = useGeoViewer();
	const [active, setActive] = useState<GeoTaskAction | null>(null);
	const actions = availableActions(task, viewer);
	if (actions.length === 0) return null;
	return (
		<div className="flex flex-wrap gap-2">
			{actions.map((action) => (
				<Button
					key={action}
					size="sm"
					variant={DESTRUCTIVE.includes(action) || action === "PAUSE" ? "outline" : "default"}
					onClick={() => setActive(action)}
				>
					{ACTION_LABELS[action]}
				</Button>
			))}
			{active && <ActionDialog key={active} task={task} action={active} onClose={() => setActive(null)} />}
		</div>
	);
}
