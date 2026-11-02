import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
	GEO_PLATFORM_LABELS,
	GEO_PLATFORMS,
	GEO_SURFACE_MODE_LABELS,
	GEO_SURFACE_MODES,
	type GeoPlatform,
	type GeoSurfaceMode,
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@workspace/ui/components/select";
import { Switch } from "@workspace/ui/components/switch";
import { Textarea } from "@workspace/ui/components/textarea";
import { useState } from "react";
import { useWriteErrorMessage } from "@/lib/write-errors";
import { createSamplingTargetFn, updateSamplingTargetFn } from "@/server/geo/sampling";
import type { SamplingTargetView } from "@/server/geo/sampling-targets-core";
import { samplingKeys } from "./keys";
import { useGeoOrganization } from "./use-geo-organization";

const CONFIG_EXAMPLES: Record<GeoSurfaceMode, string> = {
	MODEL_API: JSON.stringify(
		{
			baseUrl: "https://api.example-ai.test/v1",
			temperature: 0.7,
			maxTokens: 2048,
			pricing: { inputPer1k: 0, outputPer1k: 0 },
		},
		null,
		2,
	),
	LIVE_SURFACE: JSON.stringify(
		{
			serviceName: "已获许可的采集服务名称",
			licenseNote: "许可依据（合同或授权编号）",
			endpoint: "https://capture.example-vendor.test/v1/answers",
			auth: { type: "bearer" },
			request: { app: "{{platform}}", query: "{{prompt}}", region: "{{region}}" },
			response: { text: "data.answer", citations: "data.references", status: "data.status" },
		},
		null,
		2,
	),
	MANUAL_EVIDENCE: "{}",
};

interface FormState {
	platform: GeoPlatform;
	surfaceMode: GeoSurfaceMode;
	provider: string;
	modelId: string;
	region: string;
	language: string;
	maxConcurrency: string;
	perMinuteQuota: string;
	perDayQuota: string;
	costBudget: string;
	enabled: boolean;
	config: string;
	availableWindow: string;
	retryPolicy: string;
}

const NEW_TARGET: FormState = {
	platform: "deepseek",
	surfaceMode: "MODEL_API",
	provider: "openai-compatible",
	modelId: "",
	region: "CN",
	language: "zh-CN",
	maxConcurrency: "1",
	perMinuteQuota: "",
	perDayQuota: "",
	costBudget: "",
	enabled: false,
	config: CONFIG_EXAMPLES.MODEL_API,
	availableWindow: "",
	retryPolicy: "",
};

function jsonText(value: unknown): string {
	return value === null || value === undefined ? "" : JSON.stringify(value, null, 2);
}

function numberText(value: number | null): string {
	return value === null ? "" : String(value);
}

function initialState(target?: SamplingTargetView): FormState {
	if (!target) return NEW_TARGET;
	return {
		platform: target.platform,
		surfaceMode: target.surfaceMode,
		provider: target.provider,
		modelId: target.modelId ?? "",
		region: target.region ?? "",
		language: target.language,
		maxConcurrency: String(target.maxConcurrency),
		perMinuteQuota: numberText(target.perMinuteQuota),
		perDayQuota: numberText(target.perDayQuota),
		costBudget: numberText(target.costBudget),
		enabled: target.enabled,
		config: jsonText(target.config) || "{}",
		availableWindow: jsonText(target.availableWindow),
		retryPolicy: jsonText(target.retryPolicy),
	};
}

function parseJsonField(label: string, text: string, required: boolean): unknown {
	if (!text.trim()) {
		if (required) throw new Error(`${label}不能为空`);
		return null;
	}
	try {
		return JSON.parse(text);
	} catch {
		throw new Error(`${label}不是有效的 JSON`);
	}
}

function optionalNumber(label: string, text: string): number | null {
	if (!text.trim()) return null;
	const value = Number(text);
	if (!Number.isFinite(value) || value < 0) throw new Error(`${label}必须是非负数`);
	return value;
}

function toInput(state: FormState) {
	return {
		platform: state.platform,
		surfaceMode: state.surfaceMode,
		provider: state.provider.trim(),
		modelId: state.modelId.trim() || null,
		region: state.region.trim() || null,
		language: state.language.trim() || "zh-CN",
		config: (parseJsonField("配置", state.config, true) ?? {}) as Record<string, unknown>,
		availableWindow: parseJsonField("可用时间窗口", state.availableWindow, false),
		maxConcurrency: optionalNumber("最大并发", state.maxConcurrency) ?? 1,
		perMinuteQuota: optionalNumber("每分钟配额", state.perMinuteQuota),
		perDayQuota: optionalNumber("每日配额", state.perDayQuota),
		retryPolicy: parseJsonField("重试策略", state.retryPolicy, false) as Record<string, unknown> | null,
		costBudget: optionalNumber("成本预算", state.costBudget),
		enabled: state.enabled,
	};
}

function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: React.ReactNode }) {
	return (
		<div className="flex flex-col gap-1.5">
			<Label htmlFor={id}>{label}</Label>
			{children}
			{hint && <p className="text-xs text-muted-foreground">{hint}</p>}
		</div>
	);
}

/** Create or edit a target. Credentials are never entered here: they go through “设置凭据” into the encrypted store. */
export function TargetFormDialog({
	target,
	open,
	onOpenChange,
}: {
	target?: SamplingTargetView;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const organization = useGeoOrganization();
	const queryClient = useQueryClient();
	const writeError = useWriteErrorMessage();
	const [state, setState] = useState<FormState>(() => initialState(target));
	const [error, setError] = useState<string | null>(null);
	const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
		setState((prev) => ({ ...prev, [key]: value }));

	const save = useMutation({
		mutationFn: async () => {
			const input = toInput(state);
			if (target)
				return updateSamplingTargetFn({
					data: { organizationId: organization.id, targetId: target.id, target: input },
				});
			return createSamplingTargetFn({ data: { organizationId: organization.id, target: input } });
		},
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: samplingKeys.targets(organization.id) });
			onOpenChange(false);
		},
		onError: (err) => setError(writeError(err, "保存失败")),
	});

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>{target ? "编辑采样目标" : "新增采样目标"}</DialogTitle>
					<DialogDescription>
						更改平台、源模式、服务方、模型或配置后，验证状态会重置为未验证；端点换到新的主机时，已保存的凭据会被清除，需要重新设置。凭据请通过“设置凭据”保存，不要写入配置。
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
					<div className="grid grid-cols-2 gap-4">
						<Field id="target-platform" label="平台">
							<Select
								items={GEO_PLATFORM_LABELS}
								value={state.platform}
								onValueChange={(value) => set("platform", value as GeoPlatform)}
							>
								<SelectTrigger id="target-platform">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{GEO_PLATFORMS.map((platform) => (
										<SelectItem key={platform} value={platform}>
											{GEO_PLATFORM_LABELS[platform]}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</Field>
						<Field id="target-mode" label="源模式">
							<Select
								items={GEO_SURFACE_MODE_LABELS}
								value={state.surfaceMode}
								onValueChange={(value) => {
									const mode = value as GeoSurfaceMode;
									setState((prev) => ({
										...prev,
										surfaceMode: mode,
										config:
											prev.config.trim() && prev.config !== CONFIG_EXAMPLES[prev.surfaceMode]
												? prev.config
												: CONFIG_EXAMPLES[mode],
									}));
								}}
							>
								<SelectTrigger id="target-mode">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{GEO_SURFACE_MODES.map((mode) => (
										<SelectItem key={mode} value={mode}>
											{GEO_SURFACE_MODE_LABELS[mode]}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</Field>
						<Field id="target-provider" label="服务方">
							<Input
								id="target-provider"
								value={state.provider}
								onChange={(e) => set("provider", e.target.value)}
								required
							/>
						</Field>
						<Field id="target-model" label="模型 ID">
							<Input id="target-model" value={state.modelId} onChange={(e) => set("modelId", e.target.value)} />
						</Field>
						<Field id="target-region" label="地区">
							<Input id="target-region" value={state.region} onChange={(e) => set("region", e.target.value)} />
						</Field>
						<Field id="target-language" label="语言">
							<Input id="target-language" value={state.language} onChange={(e) => set("language", e.target.value)} />
						</Field>
						<Field id="target-concurrency" label="最大并发">
							<Input
								id="target-concurrency"
								type="number"
								min={1}
								max={20}
								value={state.maxConcurrency}
								onChange={(e) => set("maxConcurrency", e.target.value)}
							/>
						</Field>
						<Field id="target-budget" label="成本预算（近 30 天）" hint="留空表示不限">
							<Input
								id="target-budget"
								type="number"
								min={0}
								step="any"
								value={state.costBudget}
								onChange={(e) => set("costBudget", e.target.value)}
							/>
						</Field>
						<Field id="target-per-minute" label="每分钟配额" hint="留空表示不限">
							<Input
								id="target-per-minute"
								type="number"
								min={1}
								value={state.perMinuteQuota}
								onChange={(e) => set("perMinuteQuota", e.target.value)}
							/>
						</Field>
						<Field id="target-per-day" label="每日配额" hint="留空表示不限">
							<Input
								id="target-per-day"
								type="number"
								min={1}
								value={state.perDayQuota}
								onChange={(e) => set("perDayQuota", e.target.value)}
							/>
						</Field>
					</div>
					<Field
						id="target-config"
						label="配置（JSON）"
						hint="模型 API：baseUrl、temperature、maxTokens、extraBody、pricing、citationsPath。已获许可的第三方服务：serviceName、licenseNote、endpoint、auth、request、response。"
					>
						<Textarea
							id="target-config"
							className="min-h-40 font-mono text-xs"
							value={state.config}
							onChange={(e) => set("config", e.target.value)}
						/>
					</Field>
					<div className="grid grid-cols-2 gap-4">
						<Field
							id="target-window"
							label="可用时间窗口（JSON）"
							hint='如 {"timezone":"Asia/Shanghai","days":[1,2,3,4,5],"start":"09:00","end":"18:00"}；留空为全天'
						>
							<Textarea
								id="target-window"
								className="min-h-24 font-mono text-xs"
								value={state.availableWindow}
								onChange={(e) => set("availableWindow", e.target.value)}
							/>
						</Field>
						<Field
							id="target-retry"
							label="重试与熔断（JSON）"
							hint="maxAttempts、baseDelayMs、maxDelayMs、timeoutMs、breakerThreshold、breakerCooldownMs；留空用默认值"
						>
							<Textarea
								id="target-retry"
								className="min-h-24 font-mono text-xs"
								value={state.retryPolicy}
								onChange={(e) => set("retryPolicy", e.target.value)}
							/>
						</Field>
					</div>
					<div className="flex items-center gap-2">
						<Switch
							id="target-enabled"
							checked={state.enabled}
							onCheckedChange={(checked) => set("enabled", checked)}
						/>
						<Label htmlFor="target-enabled">启用</Label>
					</div>
					{error && (
						<Alert variant="destructive">
							<AlertDescription>{error}</AlertDescription>
						</Alert>
					)}
					<DialogFooter>
						<Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
							取消
						</Button>
						<Button type="submit" disabled={save.isPending}>
							{save.isPending ? "保存中…" : "保存"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
