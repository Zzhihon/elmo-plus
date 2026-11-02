import { IconPlus } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useRouteContext } from "@tanstack/react-router";
import {
	GEO_PRIORITIES,
	GEO_RISK_LEVELS,
	GEO_TASK_KINDS,
	type GeoPriority,
	type GeoRiskLevel,
	type GeoTaskKind,
	type GeoTaskSourceKind,
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
import { createGeoTaskFn } from "@/server/geo/tasks";
import { errorMessage, PRIORITY_LABELS, RISK_LABELS, SOURCE_KIND_LABELS, TASK_KIND_LABELS } from "./labels";
import { geoTaskKeys, useGeoTaskChoices } from "./queries";
import { SimpleSelect } from "./simple-select";

export interface GeoTaskEvidenceRefs {
	observationIds?: string[];
	findingIds?: string[];
	assertionIds?: string[];
}

export interface CreateTaskFromEvidenceProps {
	/** What the task is raised from. The same source with an open task returns that task instead of a new one. */
	sourceKind: Exclude<GeoTaskSourceKind, "MANUAL">;
	sourceRef: string;
	evidence: GeoTaskEvidenceRefs;
	defaultTitle?: string;
	defaultKind?: GeoTaskKind;
	defaultPriority?: GeoPriority;
	defaultRiskLevel?: GeoRiskLevel;
	promptId?: string | null;
	beforeBatchId?: string | null;
	recommendedAction?: string;
	label?: string;
	size?: "sm" | "default";
	variant?: "default" | "outline" | "secondary";
	onCreated?: (result: { id: string; created: boolean }) => void;
}

interface FormState {
	title: string;
	kind: GeoTaskKind;
	priority: GeoPriority;
	riskLevel: GeoRiskLevel;
	ownerId: string | null;
	promptId: string | null;
	recommendedAction: string;
	expectedMetric: string;
	comment: string;
}

function TaskFormDialog({
	open,
	onOpenChange,
	title,
	description,
	source,
	initial,
	onCreated,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: string;
	description: string;
	source: {
		sourceKind: GeoTaskSourceKind;
		sourceRef: string | null;
		evidence?: GeoTaskEvidenceRefs;
		beforeBatchId?: string | null;
	};
	initial: FormState;
	onCreated?: (result: { id: string; created: boolean }) => void;
}) {
	const { organization } = useRouteContext({ from: "/_authed/app/org/$org/geo" });
	const queryClient = useQueryClient();
	const choices = useGeoTaskChoices(organization.id, open);
	const [form, setForm] = useState<FormState>(initial);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [result, setResult] = useState<{ id: string; created: boolean } | null>(null);
	const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
		setForm((prev) => ({ ...prev, [key]: value }));

	const evidenceCount =
		(source.evidence?.observationIds?.length ?? 0) +
		(source.evidence?.findingIds?.length ?? 0) +
		(source.evidence?.assertionIds?.length ?? 0);

	async function submit(e: React.FormEvent) {
		e.preventDefault();
		setSaving(true);
		setError(null);
		try {
			const created = await createGeoTaskFn({
				data: {
					organizationId: organization.id,
					input: {
						title: form.title,
						kind: form.kind,
						priority: form.priority,
						riskLevel: form.riskLevel,
						ownerId: form.ownerId,
						promptId: form.promptId,
						recommendedAction: form.recommendedAction || null,
						expectedMetric: form.expectedMetric || null,
						comment: form.comment || null,
						sourceKind: source.sourceKind,
						sourceRef: source.sourceRef,
						evidence: source.evidence,
						beforeBatchId: source.beforeBatchId ?? null,
					},
				},
			});
			setResult(created);
			await queryClient.invalidateQueries({ queryKey: geoTaskKeys.all(organization.id) });
			onCreated?.(created);
		} catch (err) {
			setError(errorMessage(err));
		} finally {
			setSaving(false);
		}
	}

	function close(next: boolean) {
		onOpenChange(next);
		if (!next) {
			setResult(null);
			setError(null);
			setForm(initial);
		}
	}

	return (
		<Dialog open={open} onOpenChange={close}>
			<DialogContent className="sm:max-w-xl">
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
					<DialogDescription>{description}</DialogDescription>
				</DialogHeader>
				{result ? (
					<div className="space-y-4">
						<Alert>
							<AlertDescription>
								{result.created ? "工单已创建。" : "该来源已有未结束的工单，没有重复创建。"}
							</AlertDescription>
						</Alert>
						<DialogFooter>
							<Button variant="outline" onClick={() => close(false)}>
								关闭
							</Button>
							<Button
								render={<Link to="/app/org/$org/geo/tasks/$id" params={{ org: organization.slug, id: result.id }} />}
							>
								查看工单
							</Button>
						</DialogFooter>
					</div>
				) : (
					<form onSubmit={submit} className="space-y-4">
						{source.sourceKind !== "MANUAL" && (
							<p className="text-sm text-muted-foreground">
								来源：{SOURCE_KIND_LABELS[source.sourceKind]}，关联证据 {evidenceCount} 条
							</p>
						)}
						<div className="space-y-2">
							<Label htmlFor="task-title">标题</Label>
							<Input id="task-title" value={form.title} onChange={(e) => set("title", e.target.value)} required />
						</div>
						<div className="grid grid-cols-3 gap-3">
							<div className="space-y-2">
								<Label htmlFor="task-kind">类型</Label>
								<SimpleSelect
									id="task-kind"
									value={form.kind}
									onChange={(value) => value && set("kind", value)}
									options={GEO_TASK_KINDS.map((kind) => ({ value: kind, label: TASK_KIND_LABELS[kind] }))}
								/>
							</div>
							<div className="space-y-2">
								<Label htmlFor="task-priority">优先级</Label>
								<SimpleSelect
									id="task-priority"
									value={form.priority}
									onChange={(value) => value && set("priority", value)}
									options={GEO_PRIORITIES.map((priority) => ({ value: priority, label: PRIORITY_LABELS[priority] }))}
								/>
							</div>
							<div className="space-y-2">
								<Label htmlFor="task-risk">风险等级</Label>
								<SimpleSelect
									id="task-risk"
									value={form.riskLevel}
									onChange={(value) => value && set("riskLevel", value)}
									options={GEO_RISK_LEVELS.map((risk) => ({ value: risk, label: RISK_LABELS[risk] }))}
								/>
							</div>
						</div>
						<div className="grid grid-cols-2 gap-3">
							<div className="space-y-2">
								<Label htmlFor="task-owner">责任人</Label>
								<SimpleSelect
									id="task-owner"
									value={form.ownerId}
									onChange={(value) => set("ownerId", value)}
									noneLabel="暂不指定"
									options={(choices.data?.assignees ?? []).map((person) => ({ value: person.id, label: person.name }))}
								/>
							</div>
							<div className="space-y-2">
								<Label htmlFor="task-prompt">目标问法</Label>
								<SimpleSelect
									id="task-prompt"
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
							<Label htmlFor="task-action">建议动作</Label>
							<Textarea
								id="task-action"
								value={form.recommendedAction}
								onChange={(e) => set("recommendedAction", e.target.value)}
								rows={3}
							/>
						</div>
						<div className="space-y-2">
							<Label htmlFor="task-metric">预期指标</Label>
							<Input
								id="task-metric"
								value={form.expectedMetric}
								onChange={(e) => set("expectedMetric", e.target.value)}
								placeholder="例如：该问法在豆包的品牌提及从 0/3 提升到至少 2/3"
							/>
						</div>
						<div className="space-y-2">
							<Label htmlFor="task-comment">备注</Label>
							<Textarea
								id="task-comment"
								value={form.comment}
								onChange={(e) => set("comment", e.target.value)}
								rows={2}
							/>
						</div>
						{error && (
							<Alert variant="destructive">
								<AlertDescription>{error}</AlertDescription>
							</Alert>
						)}
						<DialogFooter>
							<Button type="button" variant="outline" onClick={() => close(false)}>
								取消
							</Button>
							<Button type="submit" disabled={saving || form.title.trim().length === 0}>
								{saving ? "创建中…" : "创建工单"}
							</Button>
						</DialogFooter>
					</form>
				)}
			</DialogContent>
		</Dialog>
	);
}

/**
 * The one way other pages raise a task from what they show: an observation, a
 * site-audit finding or a knowledge assertion. Renders nothing for someone who
 * cannot create tasks.
 */
export function CreateTaskFromEvidence(props: CreateTaskFromEvidenceProps) {
	const viewer = useGeoViewer();
	const [open, setOpen] = useState(false);
	if (!viewer.can("task.create")) return null;
	return (
		<>
			<Button size={props.size ?? "sm"} variant={props.variant ?? "outline"} onClick={() => setOpen(true)}>
				<IconPlus />
				{props.label ?? "创建优化工单"}
			</Button>
			<TaskFormDialog
				open={open}
				onOpenChange={setOpen}
				title="从证据创建优化工单"
				description="工单会关联这些诊断证据，之后的分析、审核、发布与复测都会留下操作记录。"
				source={{
					sourceKind: props.sourceKind,
					sourceRef: props.sourceRef,
					evidence: props.evidence,
					beforeBatchId: props.beforeBatchId,
				}}
				initial={{
					title: props.defaultTitle ?? "",
					kind: props.defaultKind ?? "OTHER",
					priority: props.defaultPriority ?? "P2",
					riskLevel: props.defaultRiskLevel ?? "NORMAL",
					ownerId: null,
					promptId: props.promptId ?? null,
					recommendedAction: props.recommendedAction ?? "",
					expectedMetric: "",
					comment: "",
				}}
				onCreated={props.onCreated}
			/>
		</>
	);
}

export function CreateManualTaskButton() {
	const viewer = useGeoViewer();
	const [open, setOpen] = useState(false);
	if (!viewer.can("task.create")) return null;
	return (
		<>
			<Button size="sm" onClick={() => setOpen(true)}>
				<IconPlus />
				新建工单
			</Button>
			<TaskFormDialog
				open={open}
				onOpenChange={setOpen}
				title="新建优化工单"
				description="手动创建的工单没有关联诊断证据，建议优先从采样证据或站点审计发现创建。"
				source={{ sourceKind: "MANUAL", sourceRef: null }}
				initial={{
					title: "",
					kind: "OTHER",
					priority: "P2",
					riskLevel: "NORMAL",
					ownerId: null,
					promptId: null,
					recommendedAction: "",
					expectedMetric: "",
					comment: "",
				}}
			/>
		</>
	);
}
