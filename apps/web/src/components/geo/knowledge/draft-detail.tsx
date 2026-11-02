import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useRouteContext } from "@tanstack/react-router";
import {
	contentTransition,
	GEO_FACT_BLOCKER_LABELS,
	GEO_TASK_STATE_LABELS,
	type GeoContentAction,
	isContentExportable,
} from "@workspace/geo-domain";
import { Alert, AlertDescription, AlertTitle } from "@workspace/ui/components/alert";
import { Button, buttonVariants } from "@workspace/ui/components/button";
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
import { Textarea } from "@workspace/ui/components/textarea";
import { type ReactNode, useState } from "react";
import { GeoEmptyState } from "@/components/geo/shell/empty-state";
import { GeoStatusBadge } from "@/components/geo/shell/status-badge";
import { useGeoViewer } from "@/components/geo/shell/use-geo-viewer";
import { SimpleSelect } from "@/components/geo/tasks/simple-select";
import {
	getGeoDraftVersionFn,
	linkGeoDraftTaskFn,
	recordGeoDraftPublicationFn,
	reviseGeoDraftFn,
	transitionGeoDraftFn,
} from "@/server/geo/drafts";
import type { DraftDetail } from "@/server/geo/drafts-core";
import { RiskBadge } from "./citations";
import { ContentStateBadge, FactPicker } from "./draft-list";
import {
	CHECK_STATUS_LABELS,
	CHECK_STATUS_TONES,
	CONTENT_ACTION_LABELS,
	CONTENT_KIND_LABELS,
	CONTENT_STATE_LABELS,
	errorMessage,
	formatDate,
	formatDateTime,
	TOKEN_KIND_LABELS,
} from "./labels";
import { knowledgeKeys, useGeoDraftChoices } from "./queries";

type ReviewAction = "SUBMIT" | "APPROVE_TECH" | "APPROVE_MARKETING" | "REJECT";
const REVIEW_ACTIONS: ReviewAction[] = ["SUBMIT", "APPROVE_TECH", "APPROVE_MARKETING", "REJECT"];

function Section({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
	return (
		<Card>
			<CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
				<CardTitle className="text-base">{title}</CardTitle>
				{actions}
			</CardHeader>
			<CardContent>{children}</CardContent>
		</Card>
	);
}

function useAllowed(detail: DraftDetail) {
	const viewer = useGeoViewer();
	return (action: GeoContentAction) =>
		contentTransition({
			item: { state: detail.item.approvalState, authorIds: detail.authorIds },
			action,
			actor: { kind: "principal", id: viewer.actorId, roles: viewer.roles },
			comment: "-",
		}).ok;
}

function TransitionButtons({ detail }: { detail: DraftDetail }) {
	const viewer = useGeoViewer();
	const queryClient = useQueryClient();
	const allowed = useAllowed(detail);
	const [action, setAction] = useState<ReviewAction | null>(null);
	const [comment, setComment] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const actions = REVIEW_ACTIONS.filter(allowed);
	if (actions.length === 0) return null;
	const blocked = detail.current.validation.blocking || detail.current.factProblems.length > 0;

	const submit = async () => {
		if (!action) return;
		setBusy(true);
		setError(null);
		try {
			await transitionGeoDraftFn({
				data: {
					organizationId: viewer.organizationId,
					draftId: detail.item.id,
					input: { action, comment: comment || null },
				},
			});
			await queryClient.invalidateQueries({ queryKey: knowledgeKeys.all(viewer.organizationId) });
			setAction(null);
			setComment("");
		} catch (err) {
			setError(errorMessage(err));
		} finally {
			setBusy(false);
		}
	};

	return (
		<>
			{actions.map((value) => (
				<Button
					key={value}
					size="sm"
					variant={value === "REJECT" ? "outline" : "default"}
					disabled={value !== "REJECT" && blocked}
					title={value !== "REJECT" && blocked ? "存在阻断问题，需修订后才能继续" : undefined}
					onClick={() => setAction(value)}
				>
					{CONTENT_ACTION_LABELS[value]}
				</Button>
			))}
			<Dialog open={action !== null} onOpenChange={(open) => !open && setAction(null)}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>{action ? CONTENT_ACTION_LABELS[action] : ""}</DialogTitle>
						<DialogDescription>
							{action === "REJECT"
								? "驳回后草稿回到作者手中，需要修订成新版本后重新提交，驳回意见会保留在审核记录中。"
								: "操作会记录到审核历史。作者不能审核自己撰写的内容。"}
						</DialogDescription>
					</DialogHeader>
					<div className="space-y-1">
						<Label htmlFor="draft-comment">{action === "REJECT" ? "驳回意见" : "备注（可选）"}</Label>
						<Textarea
							id="draft-comment"
							rows={4}
							value={comment}
							onChange={(event) => setComment(event.target.value)}
						/>
					</div>
					{error && (
						<Alert variant="destructive">
							<AlertDescription>{error}</AlertDescription>
						</Alert>
					)}
					<DialogFooter>
						<Button variant="outline" onClick={() => setAction(null)} disabled={busy}>
							取消
						</Button>
						<Button
							onClick={submit}
							disabled={busy || (action === "REJECT" && !comment.trim())}
							variant={action === "REJECT" ? "destructive" : "default"}
						>
							{busy ? "提交中…" : "确认"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}

function ReviseButton({ detail }: { detail: DraftDetail }) {
	const viewer = useGeoViewer();
	const queryClient = useQueryClient();
	const allowed = useAllowed(detail);
	const choices = useGeoDraftChoices(viewer.organizationId);
	const [open, setOpen] = useState(false);
	const [mode, setMode] = useState<"MANUAL" | "LLM">("MANUAL");
	const [body, setBody] = useState(detail.current.body);
	const [title, setTitle] = useState(detail.item.title);
	const [facts, setFacts] = useState(detail.current.claims.map((claim) => claim.assertionId));
	const [instructions, setInstructions] = useState("");
	const [note, setNote] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	if (!allowed("REVISE")) return null;
	const llmApproved = choices.data?.llmUseApproved ?? false;

	const submit = async () => {
		setBusy(true);
		setError(null);
		try {
			await reviseGeoDraftFn({
				data: {
					organizationId: viewer.organizationId,
					draftId: detail.item.id,
					input: {
						mode,
						title,
						assertionIds: facts,
						body: mode === "MANUAL" ? body : null,
						instructions: instructions || null,
						note: note || null,
					},
				},
			});
			await queryClient.invalidateQueries({ queryKey: knowledgeKeys.all(viewer.organizationId) });
			setOpen(false);
		} catch (err) {
			setError(errorMessage(err));
		} finally {
			setBusy(false);
		}
	};

	return (
		<>
			<Button
				size="sm"
				variant="outline"
				onClick={() => {
					setBody(detail.current.body);
					setOpen(true);
				}}
			>
				修订
			</Button>
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent className="sm:max-w-3xl">
					<DialogHeader>
						<DialogTitle>修订草稿</DialogTitle>
						<DialogDescription>
							修订会生成新的版本 v{detail.item.currentVersion + 1}，旧版本保持不变；修订后需要重新经过技术和市场审核。
						</DialogDescription>
					</DialogHeader>
					<div className="flex max-h-[70vh] flex-col gap-3 overflow-y-auto pr-1">
						<div className="grid gap-2 md:grid-cols-3">
							<div className="space-y-1 md:col-span-2">
								<Label htmlFor="revise-title">标题</Label>
								<Input id="revise-title" value={title} onChange={(event) => setTitle(event.target.value)} />
							</div>
							<div className="space-y-1">
								<Label htmlFor="revise-mode">方式</Label>
								<SimpleSelect
									id="revise-mode"
									value={mode}
									onChange={(value) => setMode(value ?? "MANUAL")}
									options={[
										{ value: "MANUAL", label: "手工修改" },
										...(llmApproved ? [{ value: "LLM" as const, label: "大模型重新生成" }] : []),
									]}
								/>
							</div>
						</div>
						<div className="space-y-1">
							<Label>引用事实（编号按选择顺序重新分配）</Label>
							<FactPicker organizationId={viewer.organizationId} selected={facts} onChange={setFacts} />
						</div>
						{mode === "MANUAL" ? (
							<div className="space-y-1">
								<Label htmlFor="revise-body">正文</Label>
								<Textarea
									id="revise-body"
									rows={14}
									className="font-mono text-sm"
									value={body}
									onChange={(event) => setBody(event.target.value)}
								/>
							</div>
						) : (
							<div className="space-y-1">
								<Label htmlFor="revise-instructions">补充要求（可选）</Label>
								<Textarea
									id="revise-instructions"
									rows={2}
									value={instructions}
									onChange={(event) => setInstructions(event.target.value)}
								/>
							</div>
						)}
						<div className="space-y-1">
							<Label htmlFor="revise-note">修订说明（可选）</Label>
							<Input id="revise-note" value={note} onChange={(event) => setNote(event.target.value)} />
						</div>
						{error && (
							<Alert variant="destructive">
								<AlertDescription>{error}</AlertDescription>
							</Alert>
						)}
					</div>
					<DialogFooter>
						<Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
							取消
						</Button>
						<Button
							onClick={submit}
							disabled={busy || facts.length === 0 || !title.trim() || (mode === "MANUAL" && !body.trim())}
						>
							{busy ? "保存中…" : "保存新版本"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}

function toLocalInput(date: Date): string {
	const offset = date.getTimezoneOffset() * 60_000;
	return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function PublishButton({ detail }: { detail: DraftDetail }) {
	const viewer = useGeoViewer();
	const queryClient = useQueryClient();
	const allowed = useAllowed(detail);
	const [open, setOpen] = useState(false);
	const [url, setUrl] = useState("");
	const [publishedAt, setPublishedAt] = useState(toLocalInput(new Date()));
	const [proofNote, setProofNote] = useState("");
	const [proofUrl, setProofUrl] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	if (!allowed("PUBLISH")) return null;

	const submit = async () => {
		setBusy(true);
		setError(null);
		try {
			await recordGeoDraftPublicationFn({
				data: {
					organizationId: viewer.organizationId,
					draftId: detail.item.id,
					input: {
						url,
						publishedAt: new Date(publishedAt).toISOString(),
						proofNote,
						proofUrl: proofUrl || null,
					},
				},
			});
			await queryClient.invalidateQueries({ queryKey: knowledgeKeys.all(viewer.organizationId) });
			setOpen(false);
		} catch (err) {
			setError(errorMessage(err));
		} finally {
			setBusy(false);
		}
	};

	return (
		<>
			<Button size="sm" onClick={() => setOpen(true)}>
				登记发布
			</Button>
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>登记发布</DialogTitle>
						<DialogDescription>
							平台不会写入任何 CMS。请在人工发布后登记实际发布地址、时间和可核验的凭证。
						</DialogDescription>
					</DialogHeader>
					<div className="flex flex-col gap-3">
						<div className="space-y-1">
							<Label htmlFor="publish-url">发布 URL</Label>
							<Input
								id="publish-url"
								value={url}
								onChange={(event) => setUrl(event.target.value)}
								placeholder="https://"
							/>
						</div>
						<div className="space-y-1">
							<Label htmlFor="publish-at">发布时间</Label>
							<Input
								id="publish-at"
								type="datetime-local"
								value={publishedAt}
								onChange={(event) => setPublishedAt(event.target.value)}
							/>
						</div>
						<div className="space-y-1">
							<Label htmlFor="publish-proof">凭证说明</Label>
							<Textarea
								id="publish-proof"
								rows={3}
								value={proofNote}
								onChange={(event) => setProofNote(event.target.value)}
							/>
						</div>
						<div className="space-y-1">
							<Label htmlFor="publish-proof-url">凭证链接（存档或截图地址，可选）</Label>
							<Input id="publish-proof-url" value={proofUrl} onChange={(event) => setProofUrl(event.target.value)} />
						</div>
						{error && (
							<Alert variant="destructive">
								<AlertDescription>{error}</AlertDescription>
							</Alert>
						)}
					</div>
					<DialogFooter>
						<Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
							取消
						</Button>
						<Button onClick={submit} disabled={busy || !url.trim() || !proofNote.trim()}>
							{busy ? "保存中…" : "登记"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}

function ExportLinks({ detail }: { detail: DraftDetail }) {
	const viewer = useGeoViewer();
	const { organization } = useRouteContext({ from: "/_authed/app/org/$org/geo" });
	if (!viewer.can("content.publish") || !isContentExportable(detail.item.approvalState)) return null;
	const base = `/api/geo/${encodeURIComponent(organization.slug)}/drafts/${detail.item.id}/export`;
	return (
		<>
			<a href={`${base}?format=md`} className={buttonVariants({ variant: "outline", size: "sm" })}>
				导出 Markdown
			</a>
			<a href={`${base}?format=html`} className={buttonVariants({ variant: "outline", size: "sm" })}>
				导出 HTML
			</a>
		</>
	);
}

function TaskLink({ detail }: { detail: DraftDetail }) {
	const viewer = useGeoViewer();
	const { organization } = useRouteContext({ from: "/_authed/app/org/$org/geo" });
	const queryClient = useQueryClient();
	const editable = viewer.can("content.write") && detail.item.approvalState !== "PUBLISHED";
	const choices = useGeoDraftChoices(viewer.organizationId, editable);
	const [error, setError] = useState<string | null>(null);
	const change = async (taskId: string | null) => {
		setError(null);
		try {
			await linkGeoDraftTaskFn({
				data: { organizationId: viewer.organizationId, draftId: detail.item.id, input: { taskId } },
			});
			await queryClient.invalidateQueries({ queryKey: knowledgeKeys.all(viewer.organizationId) });
		} catch (err) {
			setError(errorMessage(err));
		}
	};
	return (
		<div className="flex flex-col gap-2 text-sm">
			{detail.task ? (
				<div className="flex items-center gap-2">
					<GeoStatusBadge label={GEO_TASK_STATE_LABELS[detail.task.state]} />
					<Link
						to="/app/org/$org/geo/tasks/$id"
						params={{ org: organization.slug, id: detail.task.id }}
						className="hover:underline"
					>
						{detail.task.title}
					</Link>
				</div>
			) : (
				<span className="text-muted-foreground">未关联工单</span>
			)}
			{editable && (
				<div className="w-80">
					<SimpleSelect
						value={detail.item.taskId}
						onChange={change}
						noneLabel="不关联"
						options={(choices.data?.tasks ?? []).map((task) => ({ value: task.id, label: task.title }))}
					/>
				</div>
			)}
			{error && <span className="text-destructive">{error}</span>}
		</div>
	);
}

function ValidationPanel({ detail }: { detail: DraftDetail }) {
	const { validation, factProblems } = detail.current;
	const flagged = validation.checks.filter((check) => check.status !== "SUPPORTED");
	return (
		<div className="flex flex-col gap-3">
			<div className="flex flex-wrap gap-2 text-sm">
				<GeoStatusBadge
					label={validation.blocking ? `阻断 ${validation.blockingCount} 处` : "无阻断问题"}
					tone={validation.blocking ? "danger" : "success"}
				/>
				<GeoStatusBadge
					label={`待证实 ${validation.pendingCount} 处`}
					tone={validation.pendingCount ? "warning" : "neutral"}
				/>
				<GeoStatusBadge label={`已核对 ${validation.checks.length} 项`} />
			</div>
			{factProblems.length > 0 && (
				<Alert variant="destructive">
					<AlertTitle>引用的事实已不可公开</AlertTitle>
					<AlertDescription>
						<ul className="list-disc pl-4">
							{factProblems.map((problem) => (
								<li key={problem.ref}>
									{problem.ref}：{problem.blockers.map((blocker) => GEO_FACT_BLOCKER_LABELS[blocker]).join("、")}
								</li>
							))}
						</ul>
						过期、冻结、存在冲突或不再公开的事实不能进入待发布文案，请修订后再提交。
					</AlertDescription>
				</Alert>
			)}
			{validation.unknownRefs.length > 0 && (
				<Alert variant="destructive">
					<AlertDescription>正文引用了不存在的事实编号：{validation.unknownRefs.join("、")}</AlertDescription>
				</Alert>
			)}
			{flagged.length === 0 ? (
				<p className="text-sm text-muted-foreground">正文中的数字、型号、标准号和证书名都能在所引用的事实中找到。</p>
			) : (
				<ul className="divide-y text-sm">
					{flagged.map((check) => (
						<li key={`${check.segment}-${check.kind}-${check.token}`} className="flex flex-col gap-1 py-2">
							<div className="flex flex-wrap items-center gap-2">
								<GeoStatusBadge label={CHECK_STATUS_LABELS[check.status]} tone={CHECK_STATUS_TONES[check.status]} />
								<span className="font-medium">{check.token}</span>
								<span className="text-xs text-muted-foreground">{TOKEN_KIND_LABELS[check.kind]}</span>
								<RiskBadge risk={check.risk} />
								{check.supportingRefs.length > 0 && (
									<span className="text-xs text-muted-foreground">可能的来源 {check.supportingRefs.join("、")}</span>
								)}
							</div>
							<span className="text-xs text-muted-foreground">“{check.excerpt}”</span>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

function FactsPanel({ detail }: { detail: DraftDetail }) {
	const { organization } = useRouteContext({ from: "/_authed/app/org/$org/geo" });
	const cited = new Set(detail.current.validation.citedRefs);
	return (
		<ul className="divide-y text-sm">
			{detail.current.claims.map((claim) => (
				<li key={claim.ref} className="flex flex-col gap-1 py-2">
					<div className="flex flex-wrap items-center gap-2">
						<GeoStatusBadge label={claim.ref} tone={cited.has(claim.ref) ? "info" : "neutral"} />
						<Link
							to="/app/org/$org/geo/knowledge/$id"
							params={{ org: organization.slug, id: claim.assertionId }}
							className="hover:underline"
						>
							{claim.entityTitle ? `${claim.entityTitle}：` : ""}
							{claim.claimText}
						</Link>
						<RiskBadge risk={claim.riskLevel} />
						{!cited.has(claim.ref) && <span className="text-xs text-muted-foreground">正文未引用</span>}
					</div>
					<div className="flex flex-col gap-0.5 text-xs text-muted-foreground">
						{claim.sources.map((source) =>
							source.kind === "PAGE_VERSION" ? (
								<a
									key={`${source.pageVersionId}-${source.fieldPath}`}
									href={source.url}
									target="_blank"
									rel="noopener noreferrer nofollow"
									className="break-all underline"
								>
									{source.url}
									{source.fieldPath ? ` · ${source.fieldPath}` : ""}
								</a>
							) : (
								<span key={`${source.assetId}-${source.page}`}>
									客户资料《{source.title}》{source.page ? `第 ${source.page} 页` : ""}
								</span>
							),
						)}
						<span>有效期 {formatDate(claim.validUntil)}</span>
					</div>
				</li>
			))}
		</ul>
	);
}

function VersionDialog({ detail, version, onClose }: { detail: DraftDetail; version: number; onClose: () => void }) {
	const viewer = useGeoViewer();
	const { data, error } = useQuery({
		queryKey: [...knowledgeKeys.draft(viewer.organizationId, detail.item.id), "version", version],
		queryFn: () =>
			getGeoDraftVersionFn({ data: { organizationId: viewer.organizationId, draftId: detail.item.id, version } }),
	});
	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="sm:max-w-3xl">
				<DialogHeader>
					<DialogTitle>版本 v{version}</DialogTitle>
					<DialogDescription>历史版本不可修改。</DialogDescription>
				</DialogHeader>
				{error && (
					<Alert variant="destructive">
						<AlertDescription>{errorMessage(error)}</AlertDescription>
					</Alert>
				)}
				{data && (
					<pre className="max-h-[60vh] overflow-y-auto whitespace-pre-wrap rounded-md border bg-muted/40 p-3 text-sm">
						{data.body}
					</pre>
				)}
			</DialogContent>
		</Dialog>
	);
}

export function DraftDetailView({ detail }: { detail: DraftDetail }) {
	const [viewing, setViewing] = useState<number | null>(null);
	const { item, current } = detail;
	return (
		<div className="flex flex-col gap-4">
			<Section
				title="状态"
				actions={
					<div className="flex flex-wrap gap-2">
						<TransitionButtons detail={detail} />
						<ReviseButton detail={detail} />
						<ExportLinks detail={detail} />
						<PublishButton detail={detail} />
					</div>
				}
			>
				<div className="flex flex-col gap-3 text-sm">
					<div className="flex flex-wrap items-center gap-2">
						<ContentStateBadge state={item.approvalState} />
						<GeoStatusBadge label={CONTENT_KIND_LABELS[item.kind]} />
						<span className="text-muted-foreground">
							v{item.currentVersion} ·{" "}
							{current.generator === "LLM" ? `大模型生成（${current.model ?? "模型未知"}）` : "手工撰写"} ·{" "}
							{current.createdByName} · {formatDateTime(current.createdAt)}
						</span>
					</div>
					{item.approvalState === "REJECTED" && item.reviewNote && (
						<Alert variant="destructive">
							<AlertTitle>
								{item.reviewedByName} 于 {formatDateTime(item.reviewedAt)} 驳回
							</AlertTitle>
							<AlertDescription className="whitespace-pre-wrap">{item.reviewNote}</AlertDescription>
						</Alert>
					)}
					{!isContentExportable(item.approvalState) && (
						<p className="text-xs text-muted-foreground">技术审核和市场审核都通过后才能导出发布版本。</p>
					)}
				</div>
			</Section>
			<Section title="事实核对">
				<ValidationPanel detail={detail} />
			</Section>
			<Section title="正文">
				<pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed">{current.body}</pre>
			</Section>
			<Section title="引用的事实与来源">
				<FactsPanel detail={detail} />
			</Section>
			<Section title="关联工单">
				<TaskLink detail={detail} />
			</Section>
			<Section title="审核记录">
				{detail.reviews.length === 0 ? (
					<GeoEmptyState title="还没有审核记录" />
				) : (
					<ol className="divide-y text-sm">
						{detail.reviews.map((review) => (
							<li key={review.id} className="flex flex-col gap-1 py-2">
								<div className="flex flex-wrap items-center gap-2">
									<span className="font-medium">{CONTENT_ACTION_LABELS[review.action]}</span>
									<span className="text-muted-foreground">
										v{review.version} · {CONTENT_STATE_LABELS[review.fromState]} →{" "}
										{CONTENT_STATE_LABELS[review.toState]} · {review.actorName} · {formatDateTime(review.createdAt)}
									</span>
								</div>
								{review.comment && <p className="whitespace-pre-wrap">{review.comment}</p>}
							</li>
						))}
					</ol>
				)}
			</Section>
			<Section title="版本">
				<ul className="divide-y text-sm">
					{detail.versions.map((version) => (
						<li key={version.version} className="flex flex-wrap items-center gap-2 py-2">
							<button type="button" className="font-medium underline" onClick={() => setViewing(version.version)}>
								v{version.version}
							</button>
							<span className="text-muted-foreground">
								{version.generator === "LLM" ? "大模型生成" : "手工撰写"} · {version.createdByName} ·{" "}
								{formatDateTime(version.createdAt)}
							</span>
							{version.blockingCount !== null && version.blockingCount > 0 && (
								<GeoStatusBadge label={`阻断 ${version.blockingCount}`} tone="danger" />
							)}
							{version.pendingCount !== null && version.pendingCount > 0 && (
								<GeoStatusBadge label={`待证实 ${version.pendingCount}`} tone="warning" />
							)}
						</li>
					))}
				</ul>
				{viewing !== null && <VersionDialog detail={detail} version={viewing} onClose={() => setViewing(null)} />}
			</Section>
			<Section title="发布记录">
				{detail.publications.length === 0 ? (
					<GeoEmptyState title="还没有发布记录" />
				) : (
					<ul className="divide-y text-sm">
						{detail.publications.map((record) => (
							<li key={record.id} className="flex flex-col gap-1 py-2">
								<a href={record.url} target="_blank" rel="noopener noreferrer nofollow" className="break-all underline">
									{record.url}
								</a>
								<span className="text-muted-foreground">
									v{record.version} · {formatDateTime(record.publishedAt)} · 登记人 {record.recordedByName}
								</span>
								{record.proof && (
									<span className="text-xs text-muted-foreground">
										凭证：{record.proof.note}
										{record.proof.url ? `（${record.proof.url}）` : ""}
									</span>
								)}
							</li>
						))}
					</ul>
				)}
			</Section>
		</div>
	);
}
