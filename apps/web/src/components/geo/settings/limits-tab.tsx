import { useQueryClient } from "@tanstack/react-query";
import {
	GEO_RETENTION_LABELS,
	GEO_RETENTION_MINIMUM_DAYS,
	type GeoRetentionCategory,
	type GeoRetentionSettings,
} from "@workspace/geo-domain";
import { Button } from "@workspace/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@workspace/ui/components/card";
import { Input } from "@workspace/ui/components/input";
import { Label } from "@workspace/ui/components/label";
import { Textarea } from "@workspace/ui/components/textarea";
import { useState } from "react";
import { useGeoViewer } from "@/components/geo/shell/use-geo-viewer";
import { errorMessage, formatDateTime } from "@/components/geo/tasks/labels";
import { createGeoAdminRequestFn, previewGeoRetentionFn, updateGeoOperationalSettingsFn } from "@/server/geo/admin";
import type { GeoSettingsView } from "@/server/geo/admin-core";
import { ResultNotice } from "./notice";
import { geoAdminKeys, useGeoSettings } from "./queries";

function toCount(value: string): number | null {
	const trimmed = value.trim();
	return trimmed === "" ? null : Number(trimmed);
}

function OperationalForm({ organizationId, settings }: { organizationId: string; settings: GeoSettingsView }) {
	const viewer = useGeoViewer();
	const queryClient = useQueryClient();
	const [daily, setDaily] = useState(settings.samplingDailyLimit?.toString() ?? "");
	const [batch, setBatch] = useState(settings.samplingBatchLimit?.toString() ?? "");
	const [budget, setBudget] = useState(settings.samplingCostBudget ?? "");
	const [recipients, setRecipients] = useState(settings.alertRecipients.join("\n"));
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [saved, setSaved] = useState(false);

	async function submit(e: React.FormEvent) {
		e.preventDefault();
		setBusy(true);
		setError(null);
		setSaved(false);
		try {
			await updateGeoOperationalSettingsFn({
				data: {
					organizationId,
					input: {
						samplingDailyLimit: toCount(daily),
						samplingBatchLimit: toCount(batch),
						samplingCostBudget: budget.trim() || null,
						alertRecipients: recipients
							.split(/[\s,;]+/)
							.map((email) => email.trim())
							.filter(Boolean),
					},
				},
			});
			setSaved(true);
			await queryClient.invalidateQueries({ queryKey: geoAdminKeys.settings(organizationId) });
		} catch (err) {
			setError(errorMessage(err));
		} finally {
			setBusy(false);
		}
	}

	return (
		<form onSubmit={submit} className="space-y-4">
			<div className="grid gap-3 sm:grid-cols-3">
				<div className="space-y-2">
					<Label htmlFor="limit-daily">每日采样上限</Label>
					<Input
						id="limit-daily"
						inputMode="numeric"
						value={daily}
						onChange={(e) => setDaily(e.target.value)}
						placeholder="不限"
					/>
				</div>
				<div className="space-y-2">
					<Label htmlFor="limit-batch">单批次采样上限</Label>
					<Input
						id="limit-batch"
						inputMode="numeric"
						value={batch}
						onChange={(e) => setBatch(e.target.value)}
						placeholder="不限"
					/>
				</div>
				<div className="space-y-2">
					<Label htmlFor="limit-budget">采样成本预算</Label>
					<Input
						id="limit-budget"
						inputMode="decimal"
						value={budget}
						onChange={(e) => setBudget(e.target.value)}
						placeholder="不限"
					/>
				</div>
			</div>
			<div className="space-y-2">
				<Label htmlFor="alert-recipients">告警接收人（每行一个邮箱）</Label>
				<Textarea id="alert-recipients" value={recipients} onChange={(e) => setRecipients(e.target.value)} rows={3} />
				<p className="text-xs text-muted-foreground">
					{settings.emailDelivery
						? "新告警会发送到以上邮箱。"
						: "当前部署未配置邮件发送（RESEND_API_KEY、RESEND_FROM_EMAIL），告警只在工作台「运行状态」中展示。"}
				</p>
			</div>
			<ResultNotice error={error} success={saved ? "已保存" : null} />
			<Button type="submit" size="sm" disabled={busy || !viewer.can("settings.manage")}>
				保存
			</Button>
			{settings.updatedAt && (
				<p className="text-xs text-muted-foreground">上次更新：{formatDateTime(settings.updatedAt)}</p>
			)}
		</form>
	);
}

const CATEGORIES: { category: GeoRetentionCategory; key: keyof GeoRetentionSettings }[] = [
	{ category: "evidence", key: "evidenceRetentionDays" },
	{ category: "snapshot", key: "snapshotRetentionDays" },
	{ category: "audit", key: "auditRetentionDays" },
];

function RetentionForm({ organizationId, settings }: { organizationId: string; settings: GeoSettingsView }) {
	const queryClient = useQueryClient();
	const [values, setValues] = useState<Record<keyof GeoRetentionSettings, string>>({
		evidenceRetentionDays: settings.evidenceRetentionDays?.toString() ?? "",
		snapshotRetentionDays: settings.snapshotRetentionDays?.toString() ?? "",
		auditRetentionDays: settings.auditRetentionDays?.toString() ?? "",
	});
	const [reason, setReason] = useState("");
	const [preview, setPreview] = useState<Awaited<ReturnType<typeof previewGeoRetentionFn>> | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [submitted, setSubmitted] = useState(false);

	const retention: GeoRetentionSettings = {
		evidenceRetentionDays: toCount(values.evidenceRetentionDays),
		snapshotRetentionDays: toCount(values.snapshotRetentionDays),
		auditRetentionDays: toCount(values.auditRetentionDays),
	};

	async function run(action: () => Promise<void>) {
		setBusy(true);
		setError(null);
		try {
			await action();
		} catch (err) {
			setError(errorMessage(err));
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="space-y-4">
			<div className="grid gap-3 sm:grid-cols-3">
				{CATEGORIES.map(({ category, key }) => (
					<div key={key} className="space-y-2">
						<Label htmlFor={`retention-${key}`}>{GEO_RETENTION_LABELS[category]}（天）</Label>
						<Input
							id={`retention-${key}`}
							inputMode="numeric"
							value={values[key]}
							onChange={(e) => {
								setValues((prev) => ({ ...prev, [key]: e.target.value }));
								setPreview(null);
							}}
							placeholder="永久保留"
						/>
						<p className="text-xs text-muted-foreground">最少 {GEO_RETENTION_MINIMUM_DAYS[category]} 天</p>
					</div>
				))}
			</div>
			<Button
				size="sm"
				variant="outline"
				disabled={busy}
				onClick={() =>
					run(async () => setPreview(await previewGeoRetentionFn({ data: { organizationId, retention } })))
				}
			>
				预览影响
			</Button>
			{preview && (
				<ul className="space-y-1 text-sm">
					{preview.map((item) => (
						<li key={item.category}>
							{GEO_RETENTION_LABELS[item.category]}：
							{item.cutoff ? `将删除 ${formatDateTime(item.cutoff)} 之前的 ${item.rows} 条记录及对应文件` : "不删除"}
						</li>
					))}
				</ul>
			)}
			<div className="space-y-2">
				<Label htmlFor="retention-reason">申请理由</Label>
				<Textarea id="retention-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
			</div>
			<ResultNotice error={error} success={submitted ? "已提交申请，等待另一位平台管理员审批" : null} />
			<Button
				size="sm"
				disabled={busy || !preview || !reason.trim()}
				onClick={() =>
					run(async () => {
						await createGeoAdminRequestFn({
							data: { organizationId, input: { kind: "RETENTION_CHANGE", reason, retention } },
						});
						setSubmitted(true);
						await queryClient.invalidateQueries({ queryKey: geoAdminKeys.requests(organizationId) });
					})
				}
			>
				提交保留期变更申请
			</Button>
		</div>
	);
}

export function GeoLimitsTab({ organizationId }: { organizationId: string }) {
	const { data } = useGeoSettings(organizationId);
	if (!data) return null;
	return (
		<div className="grid gap-4">
			<Card>
				<CardHeader>
					<CardTitle className="text-base">采样限额与告警</CardTitle>
					<CardDescription>采样任务创建时按这些限额检查。留空表示不限。</CardDescription>
				</CardHeader>
				<CardContent>
					<OperationalForm key={data.updatedAt} organizationId={organizationId} settings={data} />
				</CardContent>
			</Card>
			<Card>
				<CardHeader>
					<CardTitle className="text-base">保留期</CardTitle>
					<CardDescription>
						默认永久保留，不删除任何数据。设置后，每天 03:40 UTC
						清理过期的采样证据、官网原始快照和审计日志，并删除对应的对象存储文件；仍被知识来源引用的快照和每个页面的最新版本不会删除。变更需要双人审批。
					</CardDescription>
				</CardHeader>
				<CardContent>
					<RetentionForm organizationId={organizationId} settings={data} />
				</CardContent>
			</Card>
		</div>
	);
}
