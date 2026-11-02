import { useQueryClient } from "@tanstack/react-query";
import {
	GEO_ADMIN_REQUEST_KIND_LABELS,
	GEO_ADMIN_REQUEST_STATUS_LABELS,
	GEO_RETENTION_LABELS,
	type GeoAdminRequestStatus,
} from "@workspace/geo-domain";
import { Button } from "@workspace/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@workspace/ui/components/card";
import { Label } from "@workspace/ui/components/label";
import { Textarea } from "@workspace/ui/components/textarea";
import { useState } from "react";
import { type GeoBadgeTone, GeoStatusBadge } from "@/components/geo/shell/status-badge";
import { useGeoViewer } from "@/components/geo/shell/use-geo-viewer";
import { errorMessage, formatDateTime } from "@/components/geo/tasks/labels";
import {
	createGeoAdminRequestFn,
	decideGeoAdminRequestFn,
	requireGeoAdminMfaFn,
	revokeGeoLlmUseFn,
} from "@/server/geo/admin";
import { ResultNotice } from "./notice";
import { geoAdminKeys, useGeoAdminRequests, useGeoSettings } from "./queries";

const STATUS_TONES: Record<GeoAdminRequestStatus, GeoBadgeTone> = {
	PENDING: "warning",
	APPROVED: "success",
	REJECTED: "danger",
	CANCELLED: "neutral",
	EXPIRED: "neutral",
};

type Request = NonNullable<ReturnType<typeof useGeoAdminRequests>["data"]>[number];

function describePayload(request: Request): string {
	const retention = request.payload.retention as Record<string, number | null> | undefined;
	if (!retention) return "";
	const parts = [
		["evidence", retention.evidenceRetentionDays],
		["snapshot", retention.snapshotRetentionDays],
		["audit", retention.auditRetentionDays],
	] as const;
	return parts
		.map(
			([category, days]) =>
				`${GEO_RETENTION_LABELS[category]}：${days === null || days === undefined ? "永久" : `${days} 天`}`,
		)
		.join("；");
}

function PendingRequest({ request, organizationId }: { request: Request; organizationId: string }) {
	const viewer = useGeoViewer();
	const queryClient = useQueryClient();
	const [comment, setComment] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const mine = request.requestedBy === viewer.actorId;

	async function decide(decision: "APPROVE" | "REJECT" | "CANCEL") {
		setBusy(true);
		setError(null);
		try {
			await decideGeoAdminRequestFn({
				data: { organizationId, input: { requestId: request.id, decision, comment: comment || null } },
			});
			await queryClient.invalidateQueries({ queryKey: geoAdminKeys.all(organizationId) });
		} catch (err) {
			setError(errorMessage(err));
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="space-y-3 rounded-md border p-3">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<div className="font-medium">{GEO_ADMIN_REQUEST_KIND_LABELS[request.kind]}</div>
				<span className="text-xs text-muted-foreground">
					{request.requestedByName} · {formatDateTime(request.createdAt)} · 截止 {formatDateTime(request.expiresAt)}
				</span>
			</div>
			<p className="whitespace-pre-wrap text-sm">理由：{request.reason}</p>
			{describePayload(request) && <p className="text-sm text-muted-foreground">{describePayload(request)}</p>}
			{mine ? (
				<div className="flex items-center justify-between gap-2">
					<span className="text-sm text-muted-foreground">需要另一位平台管理员审批。</span>
					<Button size="sm" variant="outline" disabled={busy} onClick={() => decide("CANCEL")}>
						撤回
					</Button>
				</div>
			) : (
				<div className="space-y-2">
					<Textarea
						value={comment}
						onChange={(e) => setComment(e.target.value)}
						rows={2}
						placeholder="审批意见（驳回时必填）"
					/>
					<div className="flex gap-2">
						<Button size="sm" disabled={busy} onClick={() => decide("APPROVE")}>
							批准
						</Button>
						<Button
							size="sm"
							variant="outline"
							disabled={busy || comment.trim().length === 0}
							onClick={() => decide("REJECT")}
						>
							驳回
						</Button>
					</div>
				</div>
			)}
			<ResultNotice error={error} />
		</div>
	);
}

function RequestForm({
	organizationId,
	kind,
	label,
}: {
	organizationId: string;
	kind: "LLM_USE_APPROVAL" | "ADMIN_MFA_POLICY";
	label: string;
}) {
	const queryClient = useQueryClient();
	const [reason, setReason] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function submit(e: React.FormEvent) {
		e.preventDefault();
		setBusy(true);
		setError(null);
		try {
			await createGeoAdminRequestFn({ data: { organizationId, input: { kind, reason } } });
			setReason("");
			await queryClient.invalidateQueries({ queryKey: geoAdminKeys.requests(organizationId) });
		} catch (err) {
			setError(errorMessage(err));
		} finally {
			setBusy(false);
		}
	}

	return (
		<form onSubmit={submit} className="space-y-2">
			<Label htmlFor={`reason-${kind}`}>申请理由</Label>
			<Textarea id={`reason-${kind}`} value={reason} onChange={(e) => setReason(e.target.value)} rows={2} required />
			<ResultNotice error={error} />
			<Button type="submit" size="sm" disabled={busy || !reason.trim()}>
				{label}
			</Button>
		</form>
	);
}

function ImmediateAction({
	organizationId,
	label,
	run,
	variant = "outline",
}: {
	organizationId: string;
	label: string;
	run: () => Promise<unknown>;
	variant?: "outline" | "default";
}) {
	const queryClient = useQueryClient();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	return (
		<div className="space-y-2">
			<Button
				size="sm"
				variant={variant}
				disabled={busy}
				onClick={async () => {
					setBusy(true);
					setError(null);
					try {
						await run();
						await queryClient.invalidateQueries({ queryKey: geoAdminKeys.all(organizationId) });
					} catch (err) {
						setError(errorMessage(err));
					} finally {
						setBusy(false);
					}
				}}
			>
				{label}
			</Button>
			<ResultNotice error={error} />
		</div>
	);
}

export function GeoApprovalsTab({ organizationId }: { organizationId: string }) {
	const settings = useGeoSettings(organizationId);
	const requests = useGeoAdminRequests(organizationId);
	const pending = (requests.data ?? []).filter((request) => request.status === "PENDING");
	const history = (requests.data ?? []).filter((request) => request.status !== "PENDING");
	const pendingKinds = new Set(pending.map((request) => request.kind));

	return (
		<div className="grid gap-4 lg:grid-cols-2">
			<Card className="lg:col-span-2">
				<CardHeader>
					<CardTitle className="text-base">待审批</CardTitle>
					<CardDescription>
						高风险的管理变更需要两位平台管理员：一人申请，另一人审批，申请人不能审批自己的申请。超过 48
						小时未处理会告警，7 天后自动过期。
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-3">
					{pending.length === 0 && <p className="text-sm text-muted-foreground">没有待审批的申请。</p>}
					{pending.map((request) => (
						<PendingRequest key={request.id} request={request} organizationId={organizationId} />
					))}
				</CardContent>
			</Card>

			<Card>
				<CardHeader>
					<CardTitle className="flex items-center gap-2 text-base">
						LLM 调用
						<GeoStatusBadge
							label={settings.data?.llmUseApproved ? "已批准" : "未批准"}
							tone={settings.data?.llmUseApproved ? "success" : "neutral"}
						/>
					</CardTitle>
					<CardDescription>
						批准后，语义评估和 AI
						草稿才会把内容发送给已配置的模型供应商；未批准时只使用规则评估并进入人工复核。收回批准立即生效。
					</CardDescription>
				</CardHeader>
				<CardContent>
					{settings.data?.llmUseApproved ? (
						<div className="space-y-2 text-sm">
							<p className="text-muted-foreground">批准时间：{formatDateTime(settings.data.llmApprovedAt)}</p>
							<ImmediateAction
								organizationId={organizationId}
								label="收回批准"
								run={() => revokeGeoLlmUseFn({ data: { organizationId } })}
							/>
						</div>
					) : pendingKinds.has("LLM_USE_APPROVAL") ? (
						<p className="text-sm text-muted-foreground">已有申请等待审批。</p>
					) : (
						<RequestForm organizationId={organizationId} kind="LLM_USE_APPROVAL" label="申请启用 LLM 调用" />
					)}
				</CardContent>
			</Card>

			<Card>
				<CardHeader>
					<CardTitle className="flex items-center gap-2 text-base">
						管理员两步验证要求
						<GeoStatusBadge
							label={settings.data?.adminMfaRequired === false ? "已关闭" : "已开启"}
							tone={settings.data?.adminMfaRequired === false ? "warning" : "success"}
						/>
					</CardTitle>
					<CardDescription>
						开启时，平台管理员必须启用两步验证才能使用管理设置。关闭需要双人审批，重新开启立即生效。
					</CardDescription>
				</CardHeader>
				<CardContent>
					{settings.data?.adminMfaRequired === false ? (
						<ImmediateAction
							organizationId={organizationId}
							label="重新开启要求"
							variant="default"
							run={() => requireGeoAdminMfaFn({ data: { organizationId } })}
						/>
					) : pendingKinds.has("ADMIN_MFA_POLICY") ? (
						<p className="text-sm text-muted-foreground">已有申请等待审批。</p>
					) : (
						<RequestForm organizationId={organizationId} kind="ADMIN_MFA_POLICY" label="申请关闭要求" />
					)}
				</CardContent>
			</Card>

			<Card className="lg:col-span-2">
				<CardHeader>
					<CardTitle className="text-base">审批记录</CardTitle>
				</CardHeader>
				<CardContent>
					{history.length === 0 ? (
						<p className="text-sm text-muted-foreground">暂无记录。</p>
					) : (
						<ul className="divide-y text-sm">
							{history.map((request) => (
								<li key={request.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
									<span>
										{GEO_ADMIN_REQUEST_KIND_LABELS[request.kind]} · {request.requestedByName}
										{request.decidedByName ? ` → ${request.decidedByName}` : ""}
										{request.decisionComment ? `：${request.decisionComment}` : ""}
									</span>
									<span className="flex items-center gap-2">
										<span className="text-xs text-muted-foreground">{formatDateTime(request.decidedAt)}</span>
										<GeoStatusBadge
											label={GEO_ADMIN_REQUEST_STATUS_LABELS[request.status]}
											tone={STATUS_TONES[request.status]}
										/>
									</span>
								</li>
							))}
						</ul>
					)}
				</CardContent>
			</Card>
		</div>
	);
}
