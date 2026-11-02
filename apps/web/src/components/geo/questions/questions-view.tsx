import { useMutation, useQuery } from "@tanstack/react-query";
import { GEO_PROMPT_STATUS_LABELS, GEO_PROMPT_STATUSES } from "@workspace/geo-domain";
import { Alert, AlertDescription } from "@workspace/ui/components/alert";
import { Skeleton } from "@workspace/ui/components/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@workspace/ui/components/tabs";
import { useMemo, useState } from "react";
import { geoErrorMessage } from "@/components/geo/brands/format";
import { GeoPageFrame } from "@/components/geo/shell/page-frame";
import { useGeoViewer } from "@/components/geo/shell/use-geo-viewer";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { exportGeoPromptsCsvFn, getGeoQuestionsContextFn, listGeoPromptsFn } from "@/server/geo/prompts";
import type { GeoPromptRow } from "@/server/geo/prompts-core";
import type { PromptDialogAction } from "./prompt-action-dialog";
import { ALL, PromptFilters, QuestionActions, toPromptQuery } from "./prompt-filters";
import { PromptHistoryDialog } from "./prompt-history-dialog";
import { PromptSetsPanel } from "./prompt-sets-panel";
import { PromptsTable } from "./prompts-table";
import { PromptActionHost, PromptEditorHost, PromptImportHost } from "./question-dialogs";
import { RolesPanel } from "./roles-panel";

function downloadCsv(csv: string, filename: string) {
	const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
	const link = document.createElement("a");
	link.href = url;
	link.download = filename;
	link.click();
	URL.revokeObjectURL(url);
}

export function GeoQuestionsView({ organizationId }: { organizationId: string }) {
	const viewer = useGeoViewer();
	const canWrite = viewer.can("prompt.write");

	const [tab, setTab] = useState("prompts");
	const [status, setStatus] = useState<string>(ALL);
	const [tier, setTier] = useState<string>(ALL);
	const [roleId, setRoleId] = useState<string>(ALL);
	const [search, setSearch] = useState("");
	const debouncedSearch = useDebouncedValue(search, 300);
	const [page, setPage] = useState(1);

	const [editing, setEditing] = useState<GeoPromptRow | "new" | null>(null);
	const [action, setAction] = useState<{ action: PromptDialogAction; prompt: GeoPromptRow } | null>(null);
	const [historyFor, setHistoryFor] = useState<string | null>(null);
	const [importing, setImporting] = useState(false);
	const [notice, setNotice] = useState<string | null>(null);

	const query = toPromptQuery({ status, tier, roleId, search: debouncedSearch });

	const contextQuery = useQuery({
		queryKey: ["geo-questions-context", organizationId],
		queryFn: () => getGeoQuestionsContextFn({ data: { organizationId } }),
	});
	const promptsQuery = useQuery({
		queryKey: ["geo-prompts", organizationId, query, page],
		queryFn: () => listGeoPromptsFn({ data: { organizationId, query, page } }),
		placeholderData: (previous) => previous,
	});

	const roles = contextQuery.data?.roles ?? [];
	const members = useMemo(
		() => new Map((contextQuery.data?.members ?? []).map((member) => [member.userId, member.name || member.email])),
		[contextQuery.data?.members],
	);

	const exportCsv = useMutation({
		mutationFn: () => exportGeoPromptsCsvFn({ data: { organizationId, query } }),
		onMutate: () => setNotice(null),
		onSuccess: ({ csv }) => downloadCsv(csv, `geo-prompts-${new Date().toISOString().slice(0, 10)}.csv`),
		onError: (error) => setNotice(geoErrorMessage(error)),
	});

	const filter = (setter: (value: string) => void) => (value: unknown) => {
		setter(String(value ?? ALL));
		setPage(1);
	};
	const counts = contextQuery.data?.counts;

	return (
		<GeoPageFrame
			title="问法库"
			description="按买方角色维护问法，经业务审核入选基线后组成测试集冻结。冻结的版本不可修改，同一轮监测使用固定版本。"
			actions={
				<QuestionActions
					canWrite={canWrite}
					exporting={exportCsv.isPending}
					onExport={() => exportCsv.mutate()}
					onImport={() => setImporting(true)}
					onCreate={() => setEditing("new")}
				/>
			}
		>
			{notice && (
				<Alert variant="destructive">
					<AlertDescription>{notice}</AlertDescription>
				</Alert>
			)}
			{counts && (
				<div className="flex flex-wrap gap-2 text-sm">
					{GEO_PROMPT_STATUSES.map((value) => (
						<span key={value} className="rounded-md border px-2.5 py-1">
							{GEO_PROMPT_STATUS_LABELS[value]} <span className="font-medium tabular-nums">{counts[value]}</span>
						</span>
					))}
				</div>
			)}
			<Tabs value={tab} onValueChange={(value) => setTab(String(value ?? "prompts"))}>
				<TabsList>
					<TabsTrigger value="prompts">问法</TabsTrigger>
					<TabsTrigger value="sets">测试集版本</TabsTrigger>
					<TabsTrigger value="roles">买方角色</TabsTrigger>
				</TabsList>
				<TabsContent value="prompts" className="flex flex-col gap-4">
					<PromptFilters
						roles={roles}
						search={search}
						status={status}
						tier={tier}
						roleId={roleId}
						onSearch={(value) => {
							setSearch(value);
							setPage(1);
						}}
						onStatus={filter(setStatus)}
						onTier={filter(setTier)}
						onRole={filter(setRoleId)}
					/>
					{promptsQuery.isError && (
						<Alert variant="destructive">
							<AlertDescription>{geoErrorMessage(promptsQuery.error)}</AlertDescription>
						</Alert>
					)}
					{promptsQuery.data ? (
						<PromptsTable
							data={promptsQuery.data}
							viewer={viewer}
							onPageChange={setPage}
							onEdit={setEditing}
							onAction={(prompt, next) => setAction({ prompt, action: next })}
							onHistory={(prompt) => setHistoryFor(prompt.id)}
						/>
					) : (
						<Skeleton className="h-48 w-full" />
					)}
				</TabsContent>
				<TabsContent value="sets">
					<PromptSetsPanel organizationId={organizationId} roles={roles} members={members} />
				</TabsContent>
				<TabsContent value="roles">
					<RolesPanel roles={roles} coverage={contextQuery.data?.coverage ?? []} />
				</TabsContent>
			</Tabs>

			{editing && (
				<PromptEditorHost
					key={editing === "new" ? "new" : editing.id}
					organizationId={organizationId}
					prompt={editing === "new" ? null : editing}
					roles={roles}
					members={contextQuery.data?.members ?? []}
					onClose={() => setEditing(null)}
				/>
			)}
			{action && (
				<PromptActionHost
					organizationId={organizationId}
					prompt={action.prompt}
					action={action.action}
					onClose={() => setAction(null)}
				/>
			)}
			{historyFor && (
				<PromptHistoryDialog
					organizationId={organizationId}
					promptId={historyFor}
					members={members}
					onOpenChange={(open) => !open && setHistoryFor(null)}
				/>
			)}
			{importing && <PromptImportHost organizationId={organizationId} onClose={() => setImporting(false)} />}
		</GeoPageFrame>
	);
}
