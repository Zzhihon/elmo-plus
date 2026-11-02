import { useMutation, useQueryClient } from "@tanstack/react-query";
import { GEO_RECOMMENDATION_LABELS, GEO_RECOMMENDATIONS, type GeoRecommendation } from "@workspace/geo-domain";
import { Alert, AlertDescription } from "@workspace/ui/components/alert";
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
import { Textarea } from "@workspace/ui/components/textarea";
import { useState } from "react";
import { insightKeys } from "@/components/geo/insights/search";
import { observationKeys } from "@/components/geo/sampling/keys";
import { useGeoOrganization } from "@/components/geo/sampling/use-geo-organization";
import { errorMessage } from "@/components/geo/tasks/labels";
import { SimpleSelect } from "@/components/geo/tasks/simple-select";
import { submitObservationReviewFn } from "@/server/geo/evaluation";
import type { ObservationReviewInput, ReviewClaim, ReviewEvaluation } from "@/server/geo/evaluation-core";

export function useSubmitReview(observationId: string, onDone: () => void) {
	const organization = useGeoOrganization();
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (input: ObservationReviewInput) =>
			submitObservationReviewFn({ data: { organizationId: organization.id, observationId, input } }),
		onSuccess: (review) => {
			queryClient.setQueryData(insightKeys.review(organization.id, observationId), review);
			queryClient.invalidateQueries({ queryKey: observationKeys.detail(organization.id, observationId) });
			queryClient.invalidateQueries({ queryKey: insightKeys.all(organization.id) });
			onDone();
		},
	});
}

/** Confirming appends a CONFIRMED version; correcting appends a CORRECTED one with the reviewer's basis. */
export function EvaluationReviewDialog({
	observationId,
	current,
	mode,
	onClose,
}: {
	observationId: string;
	current: ReviewEvaluation;
	mode: "CONFIRM" | "CORRECT";
	onClose: () => void;
}) {
	const [brandMentioned, setBrandMentioned] = useState(current.brandMentioned);
	const [recommendation, setRecommendation] = useState<GeoRecommendation>(current.recommendation);
	const [hasOrderedList, setHasOrderedList] = useState(current.hasOrderedList);
	const [rank, setRank] = useState(current.brandRank === null ? "" : String(current.brandRank));
	const [reason, setReason] = useState("");
	const submit = useSubmitReview(observationId, onClose);
	const correcting = mode === "CORRECT";

	const send = () =>
		submit.mutate({
			type: "evaluation",
			decision: mode,
			expectedEvaluationId: current.id,
			reason: reason.trim() || undefined,
			...(correcting
				? {
						brandMentioned,
						recommendation: brandMentioned ? recommendation : "NOT_MENTIONED",
						hasOrderedList,
						brandRank: hasOrderedList && brandMentioned && rank.trim() ? Number(rank) : null,
					}
				: {}),
		});

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>{correcting ? "更正评估结论" : "确认评估结论"}</DialogTitle>
					<DialogDescription>
						{correcting
							? "更正会生成新的评估版本并设为当前版本，原始回答与之前的版本保持不变，操作写入审计日志。"
							: `确认 v${current.version} 的结论无误。确认同样生成新的评估版本并写入审计日志。`}
					</DialogDescription>
				</DialogHeader>
				<div className="flex flex-col gap-4">
					{correcting && (
						<>
							<div className="flex items-center gap-2">
								<Checkbox
									id="review-mentioned"
									checked={brandMentioned}
									onCheckedChange={(checked) => setBrandMentioned(checked === true)}
								/>
								<Label htmlFor="review-mentioned">回答提及了本品牌</Label>
							</div>
							<div className="flex flex-col gap-1.5">
								<Label htmlFor="review-recommendation">结论</Label>
								<SimpleSelect<GeoRecommendation>
									id="review-recommendation"
									value={brandMentioned ? recommendation : "NOT_MENTIONED"}
									disabled={!brandMentioned}
									onChange={(value) => value && setRecommendation(value)}
									options={GEO_RECOMMENDATIONS.filter((value) => value !== "NOT_MENTIONED").map((value) => ({
										value,
										label: GEO_RECOMMENDATION_LABELS[value],
									}))}
								/>
							</div>
							<div className="flex items-center gap-2">
								<Checkbox
									id="review-ordered"
									checked={hasOrderedList}
									onCheckedChange={(checked) => setHasOrderedList(checked === true)}
								/>
								<Label htmlFor="review-ordered">回答包含可判定排序的厂商清单</Label>
							</div>
							{hasOrderedList && brandMentioned && (
								<div className="flex flex-col gap-1.5">
									<Label htmlFor="review-rank">品牌在清单中的位置（不在清单中则留空）</Label>
									<Input
										id="review-rank"
										type="number"
										min={1}
										max={50}
										value={rank}
										onChange={(event) => setRank(event.target.value)}
										className="w-32"
									/>
								</div>
							)}
						</>
					)}
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="review-reason">{correcting ? "更正依据（必填）" : "备注（可选）"}</Label>
						<Textarea
							id="review-reason"
							rows={3}
							value={reason}
							onChange={(event) => setReason(event.target.value)}
							placeholder={correcting ? "例如：回答第二段把本品牌列为首选，自动规则未识别" : ""}
						/>
					</div>
					{submit.error && (
						<Alert variant="destructive">
							<AlertDescription>{errorMessage(submit.error)}</AlertDescription>
						</Alert>
					)}
				</div>
				<DialogFooter>
					<Button variant="outline" onClick={onClose}>
						取消
					</Button>
					<Button onClick={send} disabled={submit.isPending || (correcting && reason.trim().length < 2)}>
						{correcting ? "保存更正" : "确认"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/** A technical reviewer's verdict on one fact claim; a confirmed error needs its basis. */
export function ClaimReviewDialog({
	observationId,
	claim,
	verdict,
	onClose,
}: {
	observationId: string;
	claim: ReviewClaim;
	verdict: "CORRECT" | "ERROR" | "UNVERIFIED";
	onClose: () => void;
}) {
	const [note, setNote] = useState(claim.reviewNote ?? "");
	const submit = useSubmitReview(observationId, onClose);
	const titles = { CORRECT: "标记为正确", ERROR: "确认为错误描述", UNVERIFIED: "恢复为待核实" } as const;
	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>{titles[verdict]}</DialogTitle>
					<DialogDescription>
						“{claim.claimText}”{claim.referenceValue ? `（已审核值：${claim.referenceValue}）` : ""}
						。错误描述率只统计技术审核确认的错误。
					</DialogDescription>
				</DialogHeader>
				<div className="flex flex-col gap-1.5">
					<Label htmlFor="claim-note">{verdict === "ERROR" ? "审核依据（必填）" : "审核意见（可选）"}</Label>
					<Textarea id="claim-note" rows={3} value={note} onChange={(event) => setNote(event.target.value)} />
				</div>
				{submit.error && (
					<Alert variant="destructive">
						<AlertDescription>{errorMessage(submit.error)}</AlertDescription>
					</Alert>
				)}
				<DialogFooter>
					<Button variant="outline" onClick={onClose}>
						取消
					</Button>
					<Button
						variant={verdict === "ERROR" ? "destructive" : "default"}
						disabled={submit.isPending || (verdict === "ERROR" && note.trim().length < 2)}
						onClick={() => submit.mutate({ type: "claim", claimId: claim.id, verdict, note: note.trim() || undefined })}
					>
						{titles[verdict]}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
