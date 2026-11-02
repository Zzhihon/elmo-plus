import { useMutation, useQuery } from "@tanstack/react-query";
import { Alert, AlertDescription } from "@workspace/ui/components/alert";
import { Button } from "@workspace/ui/components/button";
import { Skeleton } from "@workspace/ui/components/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@workspace/ui/components/table";
import { Lock, Plus } from "lucide-react";
import { useState } from "react";
import { formatGeoDateTime, geoErrorMessage } from "@/components/geo/brands/format";
import { GeoEmptyState } from "@/components/geo/shell/empty-state";
import { GeoStatusBadge } from "@/components/geo/shell/status-badge";
import { useGeoViewer } from "@/components/geo/shell/use-geo-viewer";
import {
	createGeoPromptSetFn,
	createGeoPromptSetVersionFn,
	freezeGeoPromptSetFn,
	getGeoPromptSetFn,
	listGeoPromptOptionsFn,
	listGeoPromptSetsFn,
	updateGeoPromptSetItemsFn,
} from "@/server/geo/prompts";
import type { GeoBuyerRole, GeoPromptSetSummary } from "@/server/geo/prompts-core";
import { PromptSetDetailDialog, PromptSetEditorDialog } from "./prompt-set-dialogs";
import { useInvalidateQuestions } from "./use-invalidate-questions";

type Editor = { mode: "create" } | { mode: "edit"; set: GeoPromptSetSummary; promptIds: string[] } | null;

export function PromptSetsPanel({
	organizationId,
	roles,
	members,
}: {
	organizationId: string;
	roles: GeoBuyerRole[];
	members: ReadonlyMap<string, string>;
}) {
	const viewer = useGeoViewer();
	const canWrite = viewer.can("prompt.write");
	const canFreeze = viewer.can("prompt.freeze");
	const [editor, setEditor] = useState<Editor>(null);
	const [detailFor, setDetailFor] = useState<string | null>(null);
	const [notice, setNotice] = useState<{ tone: "error" | "info"; text: string } | null>(null);

	const setsQuery = useQuery({
		queryKey: ["geo-prompt-sets", organizationId],
		queryFn: () => listGeoPromptSetsFn({ data: { organizationId } }),
	});
	const optionsQuery = useQuery({
		queryKey: ["geo-prompt-options", organizationId],
		queryFn: () => listGeoPromptOptionsFn({ data: { organizationId } }),
		enabled: editor !== null,
	});

	const refresh = useInvalidateQuestions(organizationId);

	const save = useMutation({
		mutationFn: (value: { name: string; promptIds: string[] }) =>
			editor?.mode === "edit"
				? updateGeoPromptSetItemsFn({
						data: { organizationId, setId: editor.set.id, items: { promptIds: value.promptIds } },
					})
				: createGeoPromptSetFn({ data: { organizationId, set: value } }),
		onSuccess: async () => {
			setEditor(null);
			await refresh();
		},
	});
	const act = useMutation({
		mutationFn: async (run: () => Promise<string>) => run(),
		onMutate: () => setNotice(null),
		onSuccess: async (text) => {
			setNotice({ tone: "info", text });
			await refresh();
		},
		onError: (error) => setNotice({ tone: "error", text: geoErrorMessage(error) }),
	});

	const openEdit = async (set: GeoPromptSetSummary) => {
		save.reset();
		const detail = await getGeoPromptSetFn({ data: { organizationId, setId: set.id } });
		setEditor({ mode: "edit", set, promptIds: detail.items.map((item) => item.promptId) });
	};

	const sets = setsQuery.data ?? [];
	const latestVersion = new Map<string, number>();
	for (const set of sets) latestVersion.set(set.name, Math.max(latestVersion.get(set.name) ?? 0, set.version));

	return (
		<div className="flex flex-col gap-4">
			<div className="flex items-center justify-between gap-3">
				<p className="text-sm text-muted-foreground">
					同一监测轮次只使用一个已冻结的测试集版本；冻结后的编辑会生成新版本，旧版本保持不变。
				</p>
				{canWrite && (
					<Button
						size="sm"
						onClick={() => {
							save.reset();
							setEditor({ mode: "create" });
						}}
					>
						<Plus className="size-4" />
						新建测试集
					</Button>
				)}
			</div>
			{notice && (
				<Alert variant={notice.tone === "error" ? "destructive" : "default"}>
					<AlertDescription>{notice.text}</AlertDescription>
				</Alert>
			)}
			{setsQuery.isLoading ? (
				<Skeleton className="h-32 w-full" />
			) : sets.length === 0 ? (
				<GeoEmptyState
					title="尚无测试集"
					description="把通过业务审核的核心问法组成测试集并冻结，采样轮次才能引用固定的问法版本。"
				/>
			) : (
				<div className="rounded-lg border">
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>名称</TableHead>
								<TableHead>版本</TableHead>
								<TableHead>状态</TableHead>
								<TableHead>问法数</TableHead>
								<TableHead>冻结时间</TableHead>
								<TableHead className="text-right">操作</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{sets.map((set) => {
								const isLatest = latestVersion.get(set.name) === set.version;
								return (
									<TableRow key={set.id}>
										<TableCell className="font-medium">{set.name}</TableCell>
										<TableCell>v{set.version}</TableCell>
										<TableCell>
											{set.status === "FROZEN" ? (
												<GeoStatusBadge label="已冻结" tone="success" />
											) : (
												<GeoStatusBadge label="草稿" />
											)}
										</TableCell>
										<TableCell className="tabular-nums">
											{set.itemCount}（核心 {set.coreCount}）
										</TableCell>
										<TableCell>{formatGeoDateTime(set.frozenAt)}</TableCell>
										<TableCell className="text-right">
											<SetActions
												set={set}
												isLatest={isLatest}
												canWrite={canWrite}
												canFreeze={canFreeze}
												busy={act.isPending}
												onView={() => setDetailFor(set.id)}
												onEdit={() => openEdit(set)}
												onFreeze={() =>
													act.mutate(async () => {
														const frozen = await freezeGeoPromptSetFn({ data: { organizationId, setId: set.id } });
														return `已冻结 ${frozen.name} v${frozen.version}，共 ${frozen.itemCount} 条问法。`;
													})
												}
												onNextVersion={() =>
													act.mutate(async () => {
														const next = await createGeoPromptSetVersionFn({ data: { organizationId, setId: set.id } });
														return `已生成 ${next.name} v${next.version} 草稿，可编辑后再冻结。`;
													})
												}
											/>
										</TableCell>
									</TableRow>
								);
							})}
						</TableBody>
					</Table>
				</div>
			)}

			{editor && optionsQuery.data && (
				<PromptSetEditorDialog
					title={editor.mode === "edit" ? `编辑 ${editor.set.name} v${editor.set.version}` : "新建测试集"}
					initialName={editor.mode === "edit" ? editor.set.name : ""}
					nameLocked={editor.mode === "edit"}
					initialSelection={editor.mode === "edit" ? editor.promptIds : []}
					options={optionsQuery.data}
					roles={roles}
					pending={save.isPending}
					error={save.error ? geoErrorMessage(save.error) : null}
					onOpenChange={(open) => !open && setEditor(null)}
					onSubmit={(value) => save.mutate(value)}
				/>
			)}
			{detailFor && (
				<PromptSetDetailDialog
					organizationId={organizationId}
					setId={detailFor}
					members={members}
					onOpenChange={(open) => !open && setDetailFor(null)}
				/>
			)}
		</div>
	);
}

function SetActions({
	set,
	isLatest,
	canWrite,
	canFreeze,
	busy,
	onView,
	onEdit,
	onFreeze,
	onNextVersion,
}: {
	set: GeoPromptSetSummary;
	isLatest: boolean;
	canWrite: boolean;
	canFreeze: boolean;
	busy: boolean;
	onView: () => void;
	onEdit: () => void;
	onFreeze: () => void;
	onNextVersion: () => void;
}) {
	const draft = set.status === "DRAFT";
	return (
		<>
			<Button variant="ghost" size="sm" onClick={onView}>
				查看
			</Button>
			{draft && canWrite && (
				<Button variant="ghost" size="sm" onClick={onEdit}>
					编辑条目
				</Button>
			)}
			{draft && canFreeze && (
				<Button variant="outline" size="sm" disabled={busy} onClick={onFreeze}>
					<Lock className="size-4" />
					冻结
				</Button>
			)}
			{!draft && isLatest && canWrite && (
				<Button variant="outline" size="sm" disabled={busy} onClick={onNextVersion}>
					生成新版本
				</Button>
			)}
		</>
	);
}
