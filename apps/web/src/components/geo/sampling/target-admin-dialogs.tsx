import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
	GEO_PLATFORM_LABELS,
	GEO_SURFACE_MODE_LABELS,
	GEO_VERIFICATION_LABELS,
	GEO_VERIFICATION_STATUSES,
	type GeoVerificationStatus,
} from "@workspace/geo-domain";
import { Alert, AlertDescription, AlertTitle } from "@workspace/ui/components/alert";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@workspace/ui/components/select";
import { Textarea } from "@workspace/ui/components/textarea";
import { useState } from "react";
import { useWriteErrorMessage } from "@/lib/write-errors";
import {
	checkSamplingTargetConnectivityFn,
	setSamplingTargetCredentialFn,
	setSamplingTargetVerificationFn,
} from "@/server/geo/sampling";
import type { SamplingTargetView } from "@/server/geo/sampling-targets-core";
import { formatDateTime } from "./format";
import { samplingKeys } from "./keys";
import { useGeoOrganization } from "./use-geo-organization";

function targetName(target: SamplingTargetView): string {
	return `${GEO_PLATFORM_LABELS[target.platform]} · ${GEO_SURFACE_MODE_LABELS[target.surfaceMode]}`;
}

function ErrorAlert({ message }: { message: string | null }) {
	if (!message) return null;
	return (
		<Alert variant="destructive">
			<AlertDescription>{message}</AlertDescription>
		</Alert>
	);
}

export function CredentialDialog({ target, onClose }: { target: SamplingTargetView; onClose: () => void }) {
	const organization = useGeoOrganization();
	const queryClient = useQueryClient();
	const writeError = useWriteErrorMessage();
	const [value, setValue] = useState("");
	const [error, setError] = useState<string | null>(null);
	const save = useMutation({
		mutationFn: (next: string | null) =>
			setSamplingTargetCredentialFn({ data: { organizationId: organization.id, targetId: target.id, value: next } }),
		onSuccess: async () => {
			setValue("");
			await queryClient.invalidateQueries({ queryKey: samplingKeys.targets(organization.id) });
			onClose();
		},
		onError: (err) => setError(writeError(err, "保存凭据失败")),
	});

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>设置凭据：{targetName(target)}</DialogTitle>
					<DialogDescription>
						凭据加密保存，保存后任何页面、接口和日志都不会再显示它。当前状态：
						{target.credentialConfigured ? "已设置" : "未设置"}。
					</DialogDescription>
				</DialogHeader>
				<form
					className="flex flex-col gap-4"
					onSubmit={(event) => {
						event.preventDefault();
						setError(null);
						save.mutate(value);
					}}
				>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="credential-value">新凭据</Label>
						<Input
							id="credential-value"
							type="password"
							autoComplete="off"
							data-1p-ignore
							data-lpignore="true"
							value={value}
							onChange={(e) => setValue(e.target.value)}
							required
						/>
					</div>
					<ErrorAlert message={error} />
					<DialogFooter>
						{target.credentialConfigured && (
							<Button
								type="button"
								variant="outline"
								disabled={save.isPending}
								onClick={() => {
									setError(null);
									save.mutate(null);
								}}
							>
								清除凭据
							</Button>
						)}
						<Button type="submit" disabled={save.isPending || value.length === 0}>
							保存
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

export function ConnectivityDialog({ target, onClose }: { target: SamplingTargetView; onClose: () => void }) {
	const organization = useGeoOrganization();
	const writeError = useWriteErrorMessage();
	const [error, setError] = useState<string | null>(null);
	const check = useMutation({
		mutationFn: () =>
			checkSamplingTargetConnectivityFn({ data: { organizationId: organization.id, targetId: target.id } }),
		onError: (err) => setError(writeError(err, "检测失败")),
	});

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>连通性检测：{targetName(target)}</DialogTitle>
					<DialogDescription>
						只检查端点、凭据与模型是否可用，不会发送任何问法。检测结果不会改变验证状态，验证结论需要管理员另行记录。
					</DialogDescription>
				</DialogHeader>
				{check.data && (
					<Alert variant={check.data.available ? "default" : "destructive"}>
						<AlertTitle>{check.data.available ? "端点可用" : "端点不可用"}</AlertTitle>
						<AlertDescription>
							{check.data.detail || "无更多信息"}（{formatDateTime(check.data.checkedAt)}）
						</AlertDescription>
					</Alert>
				)}
				<ErrorAlert message={error} />
				<DialogFooter>
					<Button variant="outline" onClick={onClose}>
						关闭
					</Button>
					<Button
						disabled={check.isPending}
						onClick={() => {
							setError(null);
							check.mutate();
						}}
					>
						{check.isPending ? "检测中…" : "开始检测"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

export function VerificationDialog({ target, onClose }: { target: SamplingTargetView; onClose: () => void }) {
	const organization = useGeoOrganization();
	const queryClient = useQueryClient();
	const writeError = useWriteErrorMessage();
	const [status, setStatus] = useState<GeoVerificationStatus>(target.verificationStatus);
	const [note, setNote] = useState("");
	const [error, setError] = useState<string | null>(null);
	const save = useMutation({
		mutationFn: () =>
			setSamplingTargetVerificationFn({
				data: { organizationId: organization.id, targetId: target.id, verification: { status, note } },
			}),
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: samplingKeys.targets(organization.id) });
			onClose();
		},
		onError: (err) => setError(writeError(err, "保存失败")),
	});

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>记录验证结论：{targetName(target)}</DialogTitle>
					<DialogDescription>
						“已通过”表示同一固定问题可重复采集，并保留来源、时间和原文；“限制可用”须写明限制。每次变更都写入审计日志。
					</DialogDescription>
				</DialogHeader>
				<form
					className="flex flex-col gap-4"
					onSubmit={(event) => {
						event.preventDefault();
						setError(null);
						save.mutate();
					}}
				>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="verification-status">结论</Label>
						<Select
							items={GEO_VERIFICATION_LABELS}
							value={status}
							onValueChange={(value) => setStatus(value as GeoVerificationStatus)}
						>
							<SelectTrigger id="verification-status" className="w-48">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{GEO_VERIFICATION_STATUSES.map((item) => (
									<SelectItem key={item} value={item}>
										{GEO_VERIFICATION_LABELS[item]}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="verification-note">依据与限制</Label>
						<Textarea
							id="verification-note"
							value={note}
							onChange={(e) => setNote(e.target.value)}
							placeholder="例如：PoC 期间对 10 个固定问法各采 3 次，均保存原文与时间；联网结果不可获取"
							required
						/>
					</div>
					<ErrorAlert message={error} />
					<DialogFooter>
						<Button type="button" variant="outline" onClick={onClose}>
							取消
						</Button>
						<Button type="submit" disabled={save.isPending || note.trim().length < 2}>
							保存结论
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
