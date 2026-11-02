import { useQueryClient } from "@tanstack/react-query";
import { Link, useRouteContext } from "@tanstack/react-router";
import { GEO_PUBLICATION_SCOPES, type GeoPublicationScope } from "@workspace/geo-domain";
import { Alert, AlertDescription } from "@workspace/ui/components/alert";
import { Button } from "@workspace/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@workspace/ui/components/card";
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
import { GeoAssertionStatusBadge, GeoStatusBadge } from "@/components/geo/shell/status-badge";
import { useGeoViewer } from "@/components/geo/shell/use-geo-viewer";
import { CreateTaskFromEvidence } from "@/components/geo/tasks/create-task-from-evidence";
import { SimpleSelect } from "@/components/geo/tasks/simple-select";
import { resolveKnowledgeConflictFn } from "@/server/geo/knowledge";
import type { KnowledgeCitation, KnowledgeConflictRow } from "@/server/geo/knowledge-core";
import { CitationList } from "./citations";
import {
	claimTypeLabel,
	conflictResolutionLabel,
	entityKindLabel,
	errorMessage,
	formatDateTime,
	SCOPE_LABELS,
	valueText,
} from "./labels";
import { knowledgeKeys, useKnowledgeConflicts } from "./queries";

/** Common prefix and suffix stay plain; the part that differs is marked on each side. */
function splitDiff(before: string, after: string) {
	let start = 0;
	while (start < before.length && start < after.length && before[start] === after[start]) start++;
	let end = 0;
	while (
		end < before.length - start &&
		end < after.length - start &&
		before[before.length - 1 - end] === after[after.length - 1 - end]
	) {
		end++;
	}
	return {
		prefix: before.slice(0, start),
		before: before.slice(start, before.length - end),
		after: after.slice(start, after.length - end),
		suffix: before.slice(before.length - end),
	};
}

export function ValueDiff({ before, after }: { before: string; after: string }) {
	const diff = splitDiff(before, after);
	return (
		<div className="grid gap-2 text-sm md:grid-cols-2">
			<div className="rounded-md border bg-muted/40 p-2">
				<div className="mb-1 text-xs text-muted-foreground">已批准（旧值）</div>
				<span className="whitespace-pre-wrap break-words">
					{diff.prefix}
					<mark className="bg-red-100 text-red-800">{diff.before}</mark>
					{diff.suffix}
				</span>
			</div>
			<div className="rounded-md border bg-muted/40 p-2">
				<div className="mb-1 text-xs text-muted-foreground">新发现（待审核）</div>
				<span className="whitespace-pre-wrap break-words">
					{diff.prefix}
					<mark className="bg-emerald-100 text-emerald-800">{diff.after}</mark>
					{diff.suffix}
				</span>
			</div>
		</div>
	);
}

function ResolveDialog({ conflictId, onClose }: { conflictId: string; onClose: () => void }) {
	const viewer = useGeoViewer();
	const queryClient = useQueryClient();
	const [resolution, setResolution] = useState<"KEEP_APPROVED" | "ACCEPT_CANDIDATE">("KEEP_APPROVED");
	const [basis, setBasis] = useState("");
	const [scope, setScope] = useState<GeoPublicationScope | null>("PUBLIC");
	const [validUntil, setValidUntil] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const accepting = resolution === "ACCEPT_CANDIDATE";

	const submit = async () => {
		setBusy(true);
		setError(null);
		try {
			await resolveKnowledgeConflictFn({
				data: {
					organizationId: viewer.organizationId,
					conflictId,
					input: {
						resolution,
						basis,
						publicationScope: accepting ? scope : null,
						validUntil: accepting ? validUntil || null : null,
					},
				},
			});
			await queryClient.invalidateQueries({ queryKey: knowledgeKeys.all(viewer.organizationId) });
			onClose();
		} catch (err) {
			setError(errorMessage(err));
		} finally {
			setBusy(false);
		}
	};

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>处理冲突</DialogTitle>
					<DialogDescription>
						保留原值会驳回新值；采用新值会按完整审核规则批准新值，并把旧值标记为已替代。系统不会自动覆盖已批准的事实。
					</DialogDescription>
				</DialogHeader>
				<div className="flex flex-col gap-3">
					<SimpleSelect
						value={resolution}
						onChange={(value) => setResolution(value ?? "KEEP_APPROVED")}
						options={[
							{ value: "KEEP_APPROVED", label: "保留原批准值，驳回新值" },
							{ value: "ACCEPT_CANDIDATE", label: "采用新值，替代原批准值" },
						]}
					/>
					{accepting && (
						<div className="grid grid-cols-2 gap-2">
							<div className="space-y-1">
								<Label htmlFor="resolve-scope">可公开范围</Label>
								<SimpleSelect
									id="resolve-scope"
									value={scope}
									onChange={setScope}
									options={GEO_PUBLICATION_SCOPES.map((value) => ({ value, label: SCOPE_LABELS[value] }))}
								/>
							</div>
							<div className="space-y-1">
								<Label htmlFor="resolve-valid">有效期至（可选）</Label>
								<Input
									id="resolve-valid"
									type="date"
									value={validUntil}
									onChange={(event) => setValidUntil(event.target.value)}
								/>
							</div>
						</div>
					)}
					<div className="space-y-1">
						<Label htmlFor="resolve-basis">依据</Label>
						<Textarea
							id="resolve-basis"
							rows={4}
							value={basis}
							onChange={(event) => setBasis(event.target.value)}
							placeholder="例如：客户最新版产品手册第 8 页为准"
						/>
					</div>
					{error && (
						<Alert variant="destructive">
							<AlertDescription>{error}</AlertDescription>
						</Alert>
					)}
				</div>
				<DialogFooter>
					<Button variant="outline" onClick={onClose} disabled={busy}>
						取消
					</Button>
					<Button onClick={submit} disabled={busy || !basis.trim() || (accepting && !scope)}>
						{busy ? "提交中…" : "确认处理"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

interface ConflictSide {
	id: string;
	claimText: string | null;
	value: string | string[] | string[][] | null;
	status: KnowledgeConflictRow["candidate"]["status"];
	citations: KnowledgeCitation[];
}

function SideColumn({ title, side }: { title: string; side: ConflictSide }) {
	const { organization } = useRouteContext({ from: "/_authed/app/org/$org/geo" });
	return (
		<div className="flex flex-col gap-2">
			<div className="flex items-center gap-2 text-sm font-medium">
				{title}
				<GeoAssertionStatusBadge status={side.status} />
				<Link
					to="/app/org/$org/geo/knowledge/$id"
					params={{ org: organization.slug, id: side.id }}
					className="text-xs font-normal underline"
				>
					查看
				</Link>
			</div>
			<p className="text-sm">{side.claimText ?? "保密内容（无权查看）"}</p>
			<CitationList citations={side.citations} />
		</div>
	);
}

/** Old and new value side by side, each with the page version or document it came from (UAT-18). */
export function ConflictCard({
	conflict,
}: {
	conflict: {
		id: string;
		status: "OPEN" | "RESOLVED";
		resolution: string | null;
		createdAt: string;
		title?: string | null;
		candidate: ConflictSide;
		approved: ConflictSide;
	};
}) {
	const viewer = useGeoViewer();
	const [resolving, setResolving] = useState(false);
	return (
		<Card>
			<CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
				<CardTitle className="text-base">{conflict.title ?? "值冲突"}</CardTitle>
				<div className="flex flex-wrap items-center gap-2">
					<span className="text-xs text-muted-foreground">发现于 {formatDateTime(conflict.createdAt)}</span>
					{conflict.status === "OPEN" ? (
						<>
							<CreateTaskFromEvidence
								sourceKind="ASSERTION"
								sourceRef={`conflict:${conflict.id}`}
								evidence={{ assertionIds: [conflict.candidate.id, conflict.approved.id] }}
								defaultTitle={`核对冲突事实：${conflict.title ?? conflict.candidate.claimText ?? ""}`.slice(0, 200)}
								defaultKind="FACT_CORRECTION"
								defaultRiskLevel="HIGH"
								size="sm"
								variant="outline"
							/>
							{viewer.can("knowledge.review") && (
								<Button size="sm" onClick={() => setResolving(true)}>
									处理冲突
								</Button>
							)}
						</>
					) : (
						<GeoStatusBadge label={conflictResolutionLabel(conflict.resolution)} tone="success" />
					)}
				</div>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				<ValueDiff
					before={conflict.approved.claimText ? valueText(conflict.approved.value) : "—"}
					after={conflict.candidate.claimText ? valueText(conflict.candidate.value) : "—"}
				/>
				<div className="grid gap-4 md:grid-cols-2">
					<SideColumn title="已批准" side={conflict.approved} />
					<SideColumn title="新值" side={conflict.candidate} />
				</div>
			</CardContent>
			{resolving && <ResolveDialog conflictId={conflict.id} onClose={() => setResolving(false)} />}
		</Card>
	);
}

export function ConflictList({ organizationId }: { organizationId: string }) {
	const [status, setStatus] = useState<"OPEN" | "RESOLVED">("OPEN");
	const [page, setPage] = useState(1);
	const { data, isLoading, error } = useKnowledgeConflicts(organizationId, status, page);
	return (
		<div className="flex flex-col gap-3">
			<Tabs
				value={status}
				onValueChange={(value) => {
					setStatus(value === "RESOLVED" ? "RESOLVED" : "OPEN");
					setPage(1);
				}}
			>
				<TabsList>
					<TabsTrigger value="OPEN">待处理</TabsTrigger>
					<TabsTrigger value="RESOLVED">已处理</TabsTrigger>
				</TabsList>
			</Tabs>
			{error && (
				<Alert variant="destructive">
					<AlertDescription>{errorMessage(error)}</AlertDescription>
				</Alert>
			)}
			{isLoading && !data && <Skeleton className="h-48 w-full" />}
			{data && data.rows.length === 0 && (
				<GeoEmptyState
					title={status === "OPEN" ? "没有待处理的冲突" : "没有已处理的冲突"}
					description="同一实体、同一字段出现与已批准值不同的新值时，会在这里生成冲突审核项。"
				/>
			)}
			{data?.rows.map((row) => (
				<ConflictCard
					key={row.id}
					conflict={{
						id: row.id,
						status: row.status,
						resolution: row.resolution,
						createdAt: row.createdAt,
						title: `${row.entity ? `${entityKindLabel(row.entity.kind)} ${row.entity.title} · ` : ""}${claimTypeLabel(row.claimType)} · ${row.fieldPath ?? "—"}`,
						candidate: { ...row.candidate, value: row.candidate.normalizedValue },
						approved: { ...row.approved, value: row.approved.normalizedValue },
					}}
				/>
			))}
			{data && data.totalPages > 1 && (
				<div className="flex items-center justify-end gap-2 text-sm">
					<Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage(page - 1)}>
						上一页
					</Button>
					<span>
						{page} / {data.totalPages}
					</span>
					<Button size="sm" variant="outline" disabled={page >= data.totalPages} onClick={() => setPage(page + 1)}>
						下一页
					</Button>
				</div>
			)}
		</div>
	);
}
