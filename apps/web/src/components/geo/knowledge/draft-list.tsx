import { IconSparkles } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useRouteContext } from "@tanstack/react-router";
import {
	GEO_CONTENT_APPROVAL_STATES,
	GEO_CONTENT_KINDS,
	type GeoContentApprovalState,
	type GeoContentKind,
} from "@workspace/geo-domain";
import { Alert, AlertDescription, AlertTitle } from "@workspace/ui/components/alert";
import { Button } from "@workspace/ui/components/button";
import { Checkbox } from "@workspace/ui/components/checkbox";
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
import { Skeleton } from "@workspace/ui/components/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@workspace/ui/components/tabs";
import { Textarea } from "@workspace/ui/components/textarea";
import { useState } from "react";
import { GeoEmptyState } from "@/components/geo/shell/empty-state";
import { GeoPaginatedTable } from "@/components/geo/shell/paginated-table";
import { GeoStatusBadge } from "@/components/geo/shell/status-badge";
import { useGeoViewer } from "@/components/geo/shell/use-geo-viewer";
import { SimpleSelect } from "@/components/geo/tasks/simple-select";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { createGeoDraftFn } from "@/server/geo/drafts";
import type { DraftSummary } from "@/server/geo/drafts-core";
import { RiskBadge } from "./citations";
import {
	CONTENT_KIND_LABELS,
	CONTENT_STATE_LABELS,
	CONTENT_STATE_TONES,
	errorMessage,
	formatDate,
	formatDateTime,
} from "./labels";
import { knowledgeKeys, useDraftFacts, useGeoDraftChoices, useGeoDrafts } from "./queries";

const MAX_FACTS = 40;

export function ContentStateBadge({ state }: { state: GeoContentApprovalState }) {
	return <GeoStatusBadge label={CONTENT_STATE_LABELS[state]} tone={CONTENT_STATE_TONES[state]} />;
}

/** Only approved, public, in-date, unfrozen and undisputed facts are offered here. */
export function FactPicker({
	organizationId,
	selected,
	onChange,
}: {
	organizationId: string;
	selected: string[];
	onChange: (ids: string[]) => void;
}) {
	const [search, setSearch] = useState("");
	const q = useDebouncedValue(search.trim(), 300);
	const { data, isLoading } = useDraftFacts(organizationId, q);
	const toggle = (id: string, checked: boolean) => {
		if (checked && !selected.includes(id) && selected.length < MAX_FACTS) onChange([...selected, id]);
		if (!checked) onChange(selected.filter((value) => value !== id));
	};
	return (
		<div className="flex flex-col gap-2">
			<Input placeholder="搜索可公开的已审核事实" value={search} onChange={(event) => setSearch(event.target.value)} />
			<div className="max-h-64 overflow-y-auto rounded-md border">
				{isLoading && <Skeleton className="h-24 w-full" />}
				{data && data.length === 0 && (
					<p className="p-3 text-sm text-muted-foreground">
						没有可用的事实。只有审核通过、可公开、在有效期内、未冻结且没有冲突的事实可以用于草稿。
					</p>
				)}
				{data?.map((fact) => (
					<div key={fact.id} className="flex items-start gap-2 border-b p-2 text-sm last:border-b-0">
						<Checkbox
							id={`fact-${fact.id}`}
							checked={selected.includes(fact.id)}
							onCheckedChange={(checked) => toggle(fact.id, checked === true)}
							className="mt-0.5"
						/>
						<Label htmlFor={`fact-${fact.id}`} className="cursor-pointer font-normal">
							<span className="flex flex-col gap-0.5">
								<span>
									{fact.entity && <span className="text-muted-foreground">{fact.entity.title}：</span>}
									{fact.claimText}
								</span>
								<span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
									{selected.includes(fact.id) && (
										<GeoStatusBadge label={`F${selected.indexOf(fact.id) + 1}`} tone="info" />
									)}
									<RiskBadge risk={fact.riskLevel} />
									<span>来源 {fact.sources.length} 个</span>
									<span>有效期 {formatDate(fact.validUntil)}</span>
								</span>
							</span>
						</Label>
					</div>
				))}
			</div>
			<span className="text-xs text-muted-foreground">
				已选 {selected.length} / {MAX_FACTS} 条
			</span>
		</div>
	);
}

function CreateDraftDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
	const { organization } = useRouteContext({ from: "/_authed/app/org/$org/geo" });
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const choices = useGeoDraftChoices(organization.id, open);
	const llmApproved = choices.data?.llmUseApproved ?? false;
	const [kind, setKind] = useState<GeoContentKind | null>("FAQ");
	const [title, setTitle] = useState("");
	const [taskId, setTaskId] = useState<string | null>(null);
	const [mode, setMode] = useState<"LLM" | "MANUAL">("LLM");
	const [instructions, setInstructions] = useState("");
	const [body, setBody] = useState("");
	const [facts, setFacts] = useState<string[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const effectiveMode = llmApproved ? mode : "MANUAL";

	const submit = async () => {
		if (!kind) return;
		setBusy(true);
		setError(null);
		try {
			const result = await createGeoDraftFn({
				data: {
					organizationId: organization.id,
					input: {
						kind,
						title,
						taskId,
						assertionIds: facts,
						mode: effectiveMode,
						instructions: instructions || null,
						body: effectiveMode === "MANUAL" ? body : null,
					},
				},
			});
			await queryClient.invalidateQueries({ queryKey: knowledgeKeys.all(organization.id) });
			onOpenChange(false);
			await navigate({
				to: "/app/org/$org/geo/knowledge/drafts/$draftId",
				params: { org: organization.slug, draftId: result.id },
			});
		} catch (err) {
			setError(errorMessage(err));
		} finally {
			setBusy(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>新建内容草稿</DialogTitle>
					<DialogDescription>
						草稿只能使用审核通过、可公开的事实。生成后会自动核对数字、型号和证书；高风险内容找不到来源或与来源不一致时不能提交审核。
					</DialogDescription>
				</DialogHeader>
				<div className="flex max-h-[70vh] flex-col gap-3 overflow-y-auto pr-1">
					{!llmApproved && !choices.isLoading && (
						<Alert>
							<AlertTitle>组织尚未批准调用大模型</AlertTitle>
							<AlertDescription>
								自动生成不可用，可以手工撰写。如需自动生成，请由平台管理员在“设置”中发起并完成大模型使用审批。
							</AlertDescription>
						</Alert>
					)}
					<div className="grid gap-2 md:grid-cols-3">
						<div className="space-y-1">
							<Label htmlFor="draft-kind">类型</Label>
							<SimpleSelect
								id="draft-kind"
								value={kind}
								onChange={setKind}
								options={GEO_CONTENT_KINDS.map((value) => ({ value, label: CONTENT_KIND_LABELS[value] }))}
							/>
						</div>
						<div className="space-y-1 md:col-span-2">
							<Label htmlFor="draft-title">标题 / 主题</Label>
							<Input id="draft-title" value={title} onChange={(event) => setTitle(event.target.value)} />
						</div>
						<div className="space-y-1">
							<Label htmlFor="draft-mode">撰写方式</Label>
							<SimpleSelect
								id="draft-mode"
								value={effectiveMode}
								onChange={(value) => setMode(value ?? "MANUAL")}
								disabled={!llmApproved}
								options={[
									{ value: "LLM", label: "大模型生成" },
									{ value: "MANUAL", label: "手工撰写" },
								]}
							/>
						</div>
						<div className="space-y-1 md:col-span-2">
							<Label htmlFor="draft-task">关联工单（可选）</Label>
							<SimpleSelect
								id="draft-task"
								value={taskId}
								onChange={setTaskId}
								noneLabel="不关联"
								options={(choices.data?.tasks ?? []).map((task) => ({ value: task.id, label: task.title }))}
							/>
						</div>
					</div>
					<div className="space-y-1">
						<Label>引用事实</Label>
						<FactPicker organizationId={organization.id} selected={facts} onChange={setFacts} />
					</div>
					{effectiveMode === "LLM" ? (
						<div className="space-y-1">
							<Label htmlFor="draft-instructions">补充要求（可选）</Label>
							<Textarea
								id="draft-instructions"
								rows={2}
								value={instructions}
								onChange={(event) => setInstructions(event.target.value)}
								placeholder="例如：面向采购负责人，突出选型要点"
							/>
						</div>
					) : (
						<div className="space-y-1">
							<Label htmlFor="draft-body">
								正文（Markdown，每个事实句末用 [F1] 这样的编号标注来源，编号按所选事实顺序）
							</Label>
							<Textarea id="draft-body" rows={10} value={body} onChange={(event) => setBody(event.target.value)} />
						</div>
					)}
					{error && (
						<Alert variant="destructive">
							<AlertDescription>{error}</AlertDescription>
						</Alert>
					)}
				</div>
				<DialogFooter>
					<Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
						取消
					</Button>
					<Button
						onClick={submit}
						disabled={
							busy || !kind || !title.trim() || facts.length === 0 || (effectiveMode === "MANUAL" && !body.trim())
						}
					>
						{busy
							? effectiveMode === "LLM"
								? "生成中…"
								: "保存中…"
							: effectiveMode === "LLM"
								? "生成草稿"
								: "保存草稿"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

export function CreateDraftButton() {
	const viewer = useGeoViewer();
	const [open, setOpen] = useState(false);
	if (!viewer.can("content.write")) return null;
	return (
		<>
			<Button size="sm" onClick={() => setOpen(true)}>
				<IconSparkles className="size-4" />
				新建草稿
			</Button>
			{open && <CreateDraftDialog open={open} onOpenChange={setOpen} />}
		</>
	);
}

export function DraftList({ organizationId }: { organizationId: string }) {
	const { organization } = useRouteContext({ from: "/_authed/app/org/$org/geo" });
	const [state, setState] = useState<GeoContentApprovalState | "ALL">("ALL");
	const [kind, setKind] = useState<GeoContentKind | null>(null);
	const [page, setPage] = useState(1);
	const { data, isLoading, error } = useGeoDrafts(
		organizationId,
		{ state: state === "ALL" ? undefined : state, kind: kind ?? undefined },
		page,
	);
	return (
		<div className="flex flex-col gap-3">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<Tabs
					value={state}
					onValueChange={(value) => {
						setState(value as GeoContentApprovalState | "ALL");
						setPage(1);
					}}
				>
					<TabsList>
						<TabsTrigger value="ALL">全部</TabsTrigger>
						{GEO_CONTENT_APPROVAL_STATES.map((value) => (
							<TabsTrigger key={value} value={value}>
								{CONTENT_STATE_LABELS[value]}
							</TabsTrigger>
						))}
					</TabsList>
				</Tabs>
				<div className="flex items-center gap-2">
					<div className="w-40">
						<SimpleSelect
							value={kind}
							onChange={(value) => {
								setKind(value);
								setPage(1);
							}}
							noneLabel="全部类型"
							options={GEO_CONTENT_KINDS.map((value) => ({ value, label: CONTENT_KIND_LABELS[value] }))}
						/>
					</div>
					<CreateDraftButton />
				</div>
			</div>
			{error && (
				<Alert variant="destructive">
					<AlertDescription>{errorMessage(error)}</AlertDescription>
				</Alert>
			)}
			{isLoading && !data ? (
				<Skeleton className="h-48 w-full" />
			) : (
				<GeoPaginatedTable<DraftSummary>
					rows={data?.rows ?? []}
					total={data?.total ?? 0}
					page={page}
					totalPages={data?.totalPages ?? 1}
					onPageChange={setPage}
					rowKey={(draft) => draft.id}
					empty={
						<GeoEmptyState
							title="还没有内容草稿"
							description="从已审核的可公开事实生成 FAQ、选型指南、项目案例或企业介绍。"
						/>
					}
					columns={[
						{
							key: "title",
							header: "标题",
							cell: (draft) => (
								<Link
									to="/app/org/$org/geo/knowledge/drafts/$draftId"
									params={{ org: organization.slug, draftId: draft.id }}
									className="font-medium hover:underline"
								>
									{draft.title}
								</Link>
							),
						},
						{ key: "kind", header: "类型", cell: (draft) => CONTENT_KIND_LABELS[draft.kind] },
						{ key: "state", header: "状态", cell: (draft) => <ContentStateBadge state={draft.approvalState} /> },
						{ key: "version", header: "版本", cell: (draft) => `v${draft.currentVersion}` },
						{ key: "task", header: "关联工单", cell: (draft) => draft.taskTitle ?? "—" },
						{ key: "author", header: "作者", cell: (draft) => draft.authorName ?? "—" },
						{ key: "updated", header: "更新时间", cell: (draft) => formatDateTime(draft.updatedAt) },
					]}
				/>
			)}
		</div>
	);
}
