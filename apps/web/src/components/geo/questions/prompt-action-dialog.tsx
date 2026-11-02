import { Button } from "@workspace/ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@workspace/ui/components/dialog";
import { Label } from "@workspace/ui/components/label";
import { Spinner } from "@workspace/ui/components/spinner";
import { Textarea } from "@workspace/ui/components/textarea";
import { useState } from "react";

export type PromptDialogAction = "SUBMIT" | "APPROVE" | "REJECT" | "REVISE";

const COPY: Record<PromptDialogAction, { title: string; description: string; confirm: string; needsComment: boolean }> =
	{
		SUBMIT: {
			title: "提交业务审核",
			description: "提交后问法不能直接编辑，需由另一位审核人通过或驳回。",
			confirm: "提交",
			needsComment: false,
		},
		APPROVE: {
			title: "通过审核",
			description: "通过后问法进入基线，可加入测试集并冻结。",
			confirm: "通过",
			needsComment: false,
		},
		REJECT: {
			title: "驳回问法",
			description: "驳回必须填写意见，作者修订后可重新提交。",
			confirm: "驳回",
			needsComment: true,
		},
		REVISE: {
			title: "修订问法",
			description: "问法会回到草稿，下次保存生成新的修订版本。已冻结的测试集保留原版本，不受影响。",
			confirm: "开始修订",
			needsComment: false,
		},
	};

export function PromptActionDialog({
	action,
	question,
	pending,
	error,
	onOpenChange,
	onConfirm,
}: {
	action: PromptDialogAction;
	question: string;
	pending: boolean;
	error: string | null;
	onOpenChange: (open: boolean) => void;
	onConfirm: (comment: string) => void;
}) {
	const [comment, setComment] = useState("");
	const copy = COPY[action];
	return (
		<Dialog open onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>{copy.title}</DialogTitle>
					<DialogDescription>{copy.description}</DialogDescription>
				</DialogHeader>
				<p className="rounded-md bg-muted p-3 text-sm">{question}</p>
				{action !== "SUBMIT" && (
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="prompt-action-comment">{copy.needsComment ? "驳回意见" : "备注（可选）"}</Label>
						<Textarea
							id="prompt-action-comment"
							rows={3}
							maxLength={1000}
							value={comment}
							onChange={(event) => setComment(event.target.value)}
						/>
					</div>
				)}
				{error && (
					<p className="text-sm text-destructive" role="alert">
						{error}
					</p>
				)}
				<DialogFooter>
					<Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
						取消
					</Button>
					<Button
						variant={action === "REJECT" ? "destructive" : "default"}
						disabled={pending || (copy.needsComment && !comment.trim())}
						onClick={() => onConfirm(comment)}
					>
						{pending && <Spinner />}
						{copy.confirm}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
