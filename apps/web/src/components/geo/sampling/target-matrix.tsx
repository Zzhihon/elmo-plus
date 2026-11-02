import { IconAlertTriangle, IconDots } from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { GEO_VERIFICATION_LABELS } from "@workspace/geo-domain";
import { Alert, AlertDescription, AlertTitle } from "@workspace/ui/components/alert";
import { Button } from "@workspace/ui/components/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@workspace/ui/components/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@workspace/ui/components/tooltip";
import { useState } from "react";
import { GeoEmptyState } from "@/components/geo/shell/empty-state";
import { GeoPlatformBadge, GeoSurfaceModeBadge } from "@/components/geo/shell/evidence-badge";
import { GeoStatusBadge, GeoVerificationBadge } from "@/components/geo/shell/status-badge";
import { useGeoViewer } from "@/components/geo/shell/use-geo-viewer";
import { useWriteErrorMessage } from "@/lib/write-errors";
import { setSamplingTargetEnabledFn } from "@/server/geo/sampling";
import type { SamplingTargetView } from "@/server/geo/sampling-targets-core";
import { formatCost, formatDuration, formatRate } from "./format";
import { samplingKeys } from "./keys";
import { ConnectivityDialog, CredentialDialog, VerificationDialog } from "./target-admin-dialogs";
import { TargetFormDialog } from "./target-form-dialog";
import { useGeoOrganization } from "./use-geo-organization";

type Dialog =
	| { kind: "edit" | "credential" | "connectivity" | "verification"; target: SamplingTargetView }
	| { kind: "none" };

function blockers(target: SamplingTargetView): string[] {
	const reasons: string[] = [];
	if (target.surfaceMode === "MANUAL_EVIDENCE") return target.enabled ? [] : ["未启用，启用后可导入人工证据"];
	if (!target.enabled) reasons.push("已停用");
	if (!target.platformEnabled) reasons.push("部署未开启该平台的自动采样");
	if (target.verificationStatus !== "PASSED" && target.verificationStatus !== "LIMITED") {
		reasons.push(`数据源${GEO_VERIFICATION_LABELS[target.verificationStatus]}`);
	}
	if (target.configErrors.length) reasons.push("配置不完整");
	if (!target.credentialConfigured) reasons.push("未设置凭据");
	return reasons;
}

function BreakerBadge({ state }: { state: SamplingTargetView["breakerState"] }) {
	if (state === "CLOSED") return <GeoStatusBadge label="正常" tone="success" />;
	return <GeoStatusBadge label={state === "OPEN" ? "已熔断" : "试探恢复中"} tone="danger" />;
}

function quotaText(target: SamplingTargetView): string {
	const parts = [`并发 ${target.maxConcurrency}`];
	if (target.perMinuteQuota) parts.push(`${target.perMinuteQuota}/分钟`);
	if (target.perDayQuota) parts.push(`${target.perDayQuota}/日`);
	return parts.join(" · ");
}

function TargetActions({ target, onOpen }: { target: SamplingTargetView; onOpen: (dialog: Dialog) => void }) {
	const viewer = useGeoViewer();
	const organization = useGeoOrganization();
	const queryClient = useQueryClient();
	const writeError = useWriteErrorMessage();
	const [error, setError] = useState<string | null>(null);
	const toggle = useMutation({
		mutationFn: () =>
			setSamplingTargetEnabledFn({
				data: { organizationId: organization.id, targetId: target.id, enabled: !target.enabled },
			}),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: samplingKeys.targets(organization.id) }),
		onError: (err) => setError(writeError(err, "操作失败")),
	});
	const canManage = viewer.can("target.manage");
	const canSecret = viewer.can("secret.manage") && target.surfaceMode !== "MANUAL_EVIDENCE";
	if (!canManage && !canSecret) return null;

	return (
		<div className="flex items-center justify-end gap-2">
			{error && (
				<Tooltip>
					<TooltipTrigger render={<IconAlertTriangle className="size-4 text-destructive" />} />
					<TooltipContent>{error}</TooltipContent>
				</Tooltip>
			)}
			<DropdownMenu>
				<DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label="目标操作" />}>
					<IconDots className="size-4" />
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end">
					{canManage && <DropdownMenuItem onClick={() => onOpen({ kind: "edit", target })}>编辑配置</DropdownMenuItem>}
					{canSecret && (
						<DropdownMenuItem onClick={() => onOpen({ kind: "credential", target })}>设置凭据</DropdownMenuItem>
					)}
					{canManage && (
						<>
							<DropdownMenuItem onClick={() => onOpen({ kind: "connectivity", target })}>连通性检测</DropdownMenuItem>
							<DropdownMenuItem onClick={() => onOpen({ kind: "verification", target })}>记录验证结论</DropdownMenuItem>
							<DropdownMenuSeparator />
							<DropdownMenuItem
								onClick={() => {
									setError(null);
									toggle.mutate();
								}}
							>
								{target.enabled ? "停用" : "启用"}
							</DropdownMenuItem>
						</>
					)}
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);
}

/**
 * The capability matrix. Every target shows how it samples and whether its source was
 * verified; anything short of PASSED is said plainly, never presented as full support.
 */
export function TargetMatrix({ targets }: { targets: SamplingTargetView[] }) {
	const [dialog, setDialog] = useState<Dialog>({ kind: "none" });
	const close = () => setDialog({ kind: "none" });
	const unverified = targets.filter((target) => target.verificationStatus !== "PASSED");

	if (targets.length === 0) {
		return (
			<GeoEmptyState
				title="尚未配置采样目标"
				description="管理员新增采样目标后，这里会显示各平台的源模式与验证状态。"
			/>
		);
	}

	return (
		<div className="flex flex-col gap-3">
			{unverified.length > 0 && (
				<Alert>
					<IconAlertTriangle />
					<AlertTitle>{unverified.length} 个采样目标尚未通过数据源验证</AlertTitle>
					<AlertDescription>
						未通过验证的目标不能发起自动采样，其结果也不代表已全面支持该平台。模型 API
						结果是代理评测，不等同于平台面向用户的产品回答；各源模式的指标分开统计，不合并。
					</AlertDescription>
				</Alert>
			)}
			<div className="rounded-lg border">
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>平台</TableHead>
							<TableHead>源模式</TableHead>
							<TableHead>服务方 / 模型</TableHead>
							<TableHead>验证状态</TableHead>
							<TableHead>可用性</TableHead>
							<TableHead>限额</TableHead>
							<TableHead className="text-right">近 7 天</TableHead>
							<TableHead className="w-12" />
						</TableRow>
					</TableHeader>
					<TableBody>
						{targets.map((target) => {
							const reasons = blockers(target);
							return (
								<TableRow key={target.id}>
									<TableCell>
										<GeoPlatformBadge platform={target.platform} />
									</TableCell>
									<TableCell>
										<GeoSurfaceModeBadge mode={target.surfaceMode} />
									</TableCell>
									<TableCell className="max-w-56">
										<div className="truncate text-sm">{target.provider}</div>
										<div className="truncate text-xs text-muted-foreground">{target.modelId ?? "未填写模型 ID"}</div>
									</TableCell>
									<TableCell className="max-w-64">
										<GeoVerificationBadge status={target.verificationStatus} />
										{target.verificationNote && (
											<p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{target.verificationNote}</p>
										)}
									</TableCell>
									<TableCell className="max-w-56">
										{reasons.length === 0 ? (
											<GeoStatusBadge label="可采样" tone="success" />
										) : (
											<p className="text-xs text-muted-foreground">{reasons.join("；")}</p>
										)}
										{target.surfaceMode !== "MANUAL_EVIDENCE" && target.breakerState !== "CLOSED" && (
											<div className="mt-1">
												<BreakerBadge state={target.breakerState} />
											</div>
										)}
									</TableCell>
									<TableCell className="text-xs text-muted-foreground">
										{target.surfaceMode === "MANUAL_EVIDENCE" ? "—" : quotaText(target)}
										{target.costBudget !== null && <div>预算 {formatCost(target.costBudget)} / 30 天</div>}
									</TableCell>
									<TableCell className="text-right text-xs tabular-nums text-muted-foreground">
										<div>
											{target.stats.attempts7d} 次 · 有效 {formatRate(target.stats.valid7d, target.stats.attempts7d)}
										</div>
										<div>
											P50 {formatDuration(target.stats.p50Ms)} · P95 {formatDuration(target.stats.p95Ms)}
										</div>
									</TableCell>
									<TableCell>
										<TargetActions target={target} onOpen={setDialog} />
									</TableCell>
								</TableRow>
							);
						})}
					</TableBody>
				</Table>
			</div>
			{dialog.kind === "edit" && <TargetFormDialog target={dialog.target} open onOpenChange={close} />}
			{dialog.kind === "credential" && <CredentialDialog target={dialog.target} onClose={close} />}
			{dialog.kind === "connectivity" && <ConnectivityDialog target={dialog.target} onClose={close} />}
			{dialog.kind === "verification" && <VerificationDialog target={dialog.target} onClose={close} />}
		</div>
	);
}
