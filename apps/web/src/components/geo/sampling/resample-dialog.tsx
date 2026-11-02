import { useMutation, useQueryClient } from "@tanstack/react-query";
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
import { Label } from "@workspace/ui/components/label";
import { Textarea } from "@workspace/ui/components/textarea";
import { useState } from "react";
import { useWriteErrorMessage } from "@/lib/write-errors";
import { resampleRunFn } from "@/server/geo/sampling";
import { observationKeys, samplingKeys } from "./keys";
import { useGeoOrganization } from "./use-geo-organization";

/** An explicit re-sample: a new observation linked to the old one, never an edit of it. */
export function ResampleDialog({ runId, onClose }: { runId: string; onClose: () => void }) {
	const organization = useGeoOrganization();
	const queryClient = useQueryClient();
	const writeError = useWriteErrorMessage();
	const [reason, setReason] = useState("");
	const [error, setError] = useState<string | null>(null);
	const resample = useMutation({
		mutationFn: () => resampleRunFn({ data: { organizationId: organization.id, runId, reason } }),
		onSuccess: async () => {
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: samplingKeys.all(organization.id) }),
				queryClient.invalidateQueries({ queryKey: observationKeys.all(organization.id) }),
			]);
			onClose();
		},
		onError: (err) => setError(writeError(err, "重采失败")),
	});

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>重新采样</DialogTitle>
					<DialogDescription>
						重采会生成一条新的证据并关联到原记录，原记录保持不变。同一计划样本在统计中只计一次，优先取有效结果。
					</DialogDescription>
				</DialogHeader>
				<form
					className="flex flex-col gap-4"
					onSubmit={(event) => {
						event.preventDefault();
						setError(null);
						resample.mutate();
					}}
				>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="resample-reason">重采原因</Label>
						<Textarea id="resample-reason" value={reason} onChange={(e) => setReason(e.target.value)} required />
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
						<Button type="submit" disabled={resample.isPending || reason.trim().length < 2}>
							确认重采
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
