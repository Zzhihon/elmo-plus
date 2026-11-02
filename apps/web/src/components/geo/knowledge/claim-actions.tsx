import { useQueryClient } from "@tanstack/react-query";
import {
	GEO_HIGH_RISK_REVIEWER_ROLES,
	GEO_PUBLICATION_SCOPES,
	type GeoAssertionStatus,
	type GeoPublicationScope,
	scopeAllows,
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
import { SimpleSelect } from "@/components/geo/tasks/simple-select";
import { attachKnowledgeSourceFn, reviewKnowledgeClaimFn } from "@/server/geo/knowledge";
import type { ClaimReviewDecision, KnowledgeClaimDetail } from "@/server/geo/knowledge-core";
import { DECISION_LABELS, errorMessage, formatDate, SCOPE_LABELS } from "./labels";
import { knowledgeKeys, useKnowledgeAssetChoices } from "./queries";

const REVIEW_BY_STATUS: Partial<Record<GeoAssertionStatus, ClaimReviewDecision[]>> = {
	PENDING_REVIEW: ["APPROVE", "REJECT", "REQUEST_EVIDENCE"],
	APPROVED: ["INVALIDATE"],
	SOURCE_UNAVAILABLE: ["INVALIDATE"],
};
const WRITE_BY_STATUS: Partial<Record<GeoAssertionStatus, ClaimReviewDecision[]>> = {
	NEEDS_EVIDENCE: ["RESUBMIT"],
	REJECTED: ["RESUBMIT"],
	SOURCE_UNAVAILABLE: ["RESUBMIT"],
};

function availableDecisions(
	detail: KnowledgeClaimDetail,
	can: (permission: "knowledge.review" | "knowledge.write") => boolean,
): ClaimReviewDecision[] {
	const { claim } = detail;
	const decisions: ClaimReviewDecision[] = [];
	if (can("knowledge.review")) decisions.push(...(REVIEW_BY_STATUS[claim.status] ?? []));
	if (can("knowledge.write")) decisions.push(...(WRITE_BY_STATUS[claim.status] ?? []));
	if (can("knowledge.review") && claim.status !== "SUPERSEDED") decisions.push(claim.frozen ? "UNFREEZE" : "FREEZE");
	return decisions;
}

function ApprovalNotes({ detail }: { detail: KnowledgeClaimDetail }) {
	const viewer = useGeoViewer();
	const { gates, claim } = detail;
	const notes: string[] = [];
	if (gates.effectiveRisk === "HIGH") {
		if (!viewer.roles.some((role) => GEO_HIGH_RISK_REVIEWER_ROLES.includes(role))) {
			notes.push("这是高风险事实，只有技术审核人或市场审核人可以确认。");
		}
		if (!gates.hasOriginalDocument) {
			notes.push("这是高风险事实，必须先关联一份已确认、在有效期内的客户原件，不能只凭官网页面批准。");
		}
		if (claim.authorId === viewer.actorId) notes.push("高风险事实不能由录入人本人审核。");
	}
	if (claim.openConflicts > 0) notes.push("存在未解决的冲突，请先在冲突中处理。");
	if (claim.frozen) notes.push("事实已被冻结，解冻后才能审核通过。");
	if (!gates.widestScope) notes.push("没有仍然有效的来源。");
	if (notes.length === 0) return null;
	return (
		<Alert variant="destructive">
			<AlertDescription>
				<ul className="list-disc pl-4">
					{notes.map((note) => (
						<li key={note}>{note}</li>
					))}
				</ul>
			</AlertDescription>
		</Alert>
	);
}

function ReviewDialog({
	detail,
	decision,
	onClose,
}: {
	detail: KnowledgeClaimDetail;
	decision: ClaimReviewDecision;
	onClose: () => void;
}) {
	const viewer = useGeoViewer();
	const queryClient = useQueryClient();
	const widest = detail.gates.widestScope;
	const scopes = GEO_PUBLICATION_SCOPES.filter((scope) => widest && scopeAllows(widest, scope));
	const [basis, setBasis] = useState("");
	const [scope, setScope] = useState<GeoPublicationScope | null>(
		scopes.includes("PUBLIC") ? "PUBLIC" : (scopes[0] ?? null),
	);
	const [validUntil, setValidUntil] = useState(detail.claim.validUntil?.slice(0, 10) ?? "");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const approving = decision === "APPROVE";

	const submit = async () => {
		setBusy(true);
		setError(null);
		try {
			await reviewKnowledgeClaimFn({
				data: {
					organizationId: viewer.organizationId,
					claimId: detail.claim.id,
					input: {
						decision,
						basis,
						publicationScope: approving ? scope : null,
						validUntil: approving ? validUntil || null : undefined,
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
					<DialogTitle>{DECISION_LABELS[decision]}</DialogTitle>
					<DialogDescription>
						审核记录会绑定当前全部来源版本、操作者、时间、依据和可公开范围，且不可修改。
					</DialogDescription>
				</DialogHeader>
				<div className="flex flex-col gap-3">
					{approving && <ApprovalNotes detail={detail} />}
					{approving && (
						<>
							<div className="space-y-1">
								<Label htmlFor="review-scope">可公开范围</Label>
								<SimpleSelect
									id="review-scope"
									value={scope}
									onChange={setScope}
									placeholder="选择可公开范围"
									options={scopes.map((value) => ({ value, label: SCOPE_LABELS[value] }))}
								/>
								<p className="text-xs text-muted-foreground">
									来源最宽允许：{widest ? SCOPE_LABELS[widest] : "无有效来源"}
									。客户原件中的内容不会超过资料登记的可公开范围。
								</p>
							</div>
							<div className="space-y-1">
								<Label htmlFor="review-valid">有效期至（可选）</Label>
								<Input
									id="review-valid"
									type="date"
									value={validUntil}
									onChange={(event) => setValidUntil(event.target.value)}
								/>
								<p className="text-xs text-muted-foreground">
									按来源资料计算的有效期：{formatDate(detail.gates.validUntilOnApproval)}。填写的日期只能更早。
								</p>
							</div>
						</>
					)}
					<div className="space-y-1">
						<Label htmlFor="review-basis">依据</Label>
						<Textarea
							id="review-basis"
							rows={4}
							value={basis}
							onChange={(event) => setBasis(event.target.value)}
							placeholder="例如：已核对客户提供的产品手册第 12 页参数表"
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
					<Button
						onClick={submit}
						disabled={busy || !basis.trim() || (approving && !scope)}
						variant={decision === "REJECT" || decision === "INVALIDATE" ? "destructive" : "default"}
					>
						{busy ? "提交中…" : DECISION_LABELS[decision]}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

export function ClaimReviewActions({ detail }: { detail: KnowledgeClaimDetail }) {
	const viewer = useGeoViewer();
	const [decision, setDecision] = useState<ClaimReviewDecision | null>(null);
	const decisions = availableDecisions(detail, viewer.can);
	if (decisions.length === 0) return null;
	return (
		<div className="flex flex-wrap gap-2">
			{decisions.map((value) => (
				<Button
					key={value}
					size="sm"
					variant={value === "APPROVE" ? "default" : "outline"}
					onClick={() => setDecision(value)}
				>
					{DECISION_LABELS[value]}
				</Button>
			))}
			{decision && <ReviewDialog detail={detail} decision={decision} onClose={() => setDecision(null)} />}
		</div>
	);
}

/** Binds a customer original, with page and paragraph, to a claim the website produced. */
export function AttachOriginalButton({ detail }: { detail: KnowledgeClaimDetail }) {
	const viewer = useGeoViewer();
	const queryClient = useQueryClient();
	const [open, setOpen] = useState(false);
	const choices = useKnowledgeAssetChoices(viewer.organizationId, open);
	const [assetId, setAssetId] = useState<string | null>(null);
	const [page, setPage] = useState("");
	const [paragraph, setParagraph] = useState("");
	const [quote, setQuote] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	if (!viewer.can("knowledge.write") || detail.claim.status === "SUPERSEDED") return null;

	const submit = async () => {
		if (!assetId) return;
		setBusy(true);
		setError(null);
		try {
			await attachKnowledgeSourceFn({
				data: {
					organizationId: viewer.organizationId,
					claimId: detail.claim.id,
					input: {
						assetId,
						locator: { page: page ? Number(page) : null, paragraph: paragraph || null, quote: quote || null },
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
			<Button size="sm" variant="outline" onClick={() => setOpen(true)}>
				关联客户原件
			</Button>
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent className="sm:max-w-lg">
					<DialogHeader>
						<DialogTitle>关联客户原件</DialogTitle>
						<DialogDescription>
							在原件上标出这条主张所在的页码或段落。高风险事实需要原件经审核人确认且在有效期内。
						</DialogDescription>
					</DialogHeader>
					<div className="flex flex-col gap-3">
						<div className="space-y-1">
							<Label htmlFor="attach-asset">资料</Label>
							<SimpleSelect
								id="attach-asset"
								value={assetId}
								onChange={setAssetId}
								placeholder={choices.isLoading ? "加载中…" : "选择已上传的资料"}
								options={(choices.data ?? []).map((asset) => ({
									value: asset.id,
									label: `${asset.title}${asset.approvalStatus === "APPROVED" ? "" : "（待确认）"}`,
								}))}
							/>
						</div>
						<div className="grid grid-cols-2 gap-2">
							<div className="space-y-1">
								<Label htmlFor="attach-page">页码</Label>
								<Input
									id="attach-page"
									inputMode="numeric"
									value={page}
									onChange={(event) => setPage(event.target.value.replace(/\D/g, ""))}
								/>
							</div>
							<div className="space-y-1">
								<Label htmlFor="attach-paragraph">段落 / 表格位置</Label>
								<Input id="attach-paragraph" value={paragraph} onChange={(event) => setParagraph(event.target.value)} />
							</div>
						</div>
						<div className="space-y-1">
							<Label htmlFor="attach-quote">原文摘录（可选）</Label>
							<Textarea id="attach-quote" rows={3} value={quote} onChange={(event) => setQuote(event.target.value)} />
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
						<Button onClick={submit} disabled={busy || !assetId || (!page && !paragraph)}>
							{busy ? "保存中…" : "关联"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}
