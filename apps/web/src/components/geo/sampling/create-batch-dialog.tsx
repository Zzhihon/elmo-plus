import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	GEO_CATALOG_SET_NAME,
	GEO_PLATFORM_LABELS,
	GEO_SURFACE_MODE_LABELS,
	isImportOnlySurface,
} from "@workspace/geo-domain";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@workspace/ui/components/select";
import { useMemo, useState } from "react";
import { GeoVerificationBadge } from "@/components/geo/shell/status-badge";
import { useWriteErrorMessage } from "@/lib/write-errors";
import { createSamplingBatchFn, listFrozenPromptSetsFn } from "@/server/geo/sampling";
import type { SamplingTargetView } from "@/server/geo/sampling-targets-core";
import { samplingKeys } from "./keys";
import { useGeoOrganization } from "./use-geo-organization";

/** Frozen question set × chosen targets × repeats; only targets that can actually run are selectable. */
export function CreateBatchDialog({
	targets,
	open,
	onOpenChange,
}: {
	targets: SamplingTargetView[];
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const organization = useGeoOrganization();
	const queryClient = useQueryClient();
	const writeError = useWriteErrorMessage();
	const [chosenSetId, setPromptSetId] = useState<string | null>(null);
	const [selected, setSelected] = useState<string[]>([]);
	const [repeatCount, setRepeatCount] = useState("3");
	const [includeExtended, setIncludeExtended] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [idempotencyKey] = useState(() => `ui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`);

	const sets = useQuery({
		queryKey: samplingKeys.promptSets(organization.id),
		queryFn: () => listFrozenPromptSetsFn({ data: { organizationId: organization.id } }),
		enabled: open,
	});
	const automatic = targets.filter((target) => !isImportOnlySurface(target.surfaceMode));
	// Sets arrive newest first; the customer's own questions are what a routine round should ask.
	const newestSet = sets.data?.find((item) => item.name === GEO_CATALOG_SET_NAME) ?? sets.data?.[0];
	const promptSetId = chosenSetId ?? newestSet?.id ?? null;
	const set = sets.data?.find((item) => item.id === promptSetId);
	const repeats = Number(repeatCount);
	const questions = set ? (includeExtended ? set.itemCount : set.coreCount) : 0;
	const planned = Number.isInteger(repeats) ? questions * selected.length * repeats : 0;
	const setItems = useMemo(
		() => Object.fromEntries((sets.data ?? []).map((item) => [item.id, `${item.name} · v${item.version}`])),
		[sets.data],
	);

	const create = useMutation({
		mutationFn: () =>
			createSamplingBatchFn({
				data: {
					organizationId: organization.id,
					batch: {
						promptSetId: promptSetId ?? "",
						targetIds: selected,
						repeatCount: repeats,
						includeExtended,
						idempotencyKey,
					},
				},
			}),
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: samplingKeys.all(organization.id) });
			onOpenChange(false);
		},
		onError: (err) => setError(writeError(err, "发起采样失败")),
	});

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-xl">
				<DialogHeader>
					<DialogTitle>发起采样</DialogTitle>
					<DialogDescription>
						按冻结的问法集、所选目标和重复次数生成计划。失败、限流和不可用的样本不计入任何比率的分母，重试也不会重复计数。
					</DialogDescription>
				</DialogHeader>
				<form
					className="flex flex-col gap-4"
					onSubmit={(event) => {
						event.preventDefault();
						setError(null);
						create.mutate();
					}}
				>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="batch-set">问法集（已冻结）</Label>
						<Select items={setItems} value={promptSetId} onValueChange={(value) => setPromptSetId(value as string)}>
							<SelectTrigger id="batch-set">
								<SelectValue placeholder={sets.isLoading ? "加载中…" : "选择问法集"} />
							</SelectTrigger>
							<SelectContent>
								{(sets.data ?? []).map((item) => (
									<SelectItem key={item.id} value={item.id}>
										{item.name} · v{item.version}（核心 {item.coreCount} 问
										{item.extendedCount > 0 ? `，扩展 ${item.extendedCount} 问` : ""}）
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						{sets.data?.length === 0 && (
							<p className="text-xs text-muted-foreground">还没有冻结的问法集，请先在问法库冻结基线。</p>
						)}
					</div>
					{set && set.extendedCount > 0 && (
						<label className="flex items-start gap-2 text-sm" htmlFor="batch-include-extended">
							<Checkbox
								id="batch-include-extended"
								checked={includeExtended}
								onCheckedChange={(checked) => setIncludeExtended(checked === true)}
							/>
							<span>
								同时采样 {set.extendedCount} 个扩展问法
								<span className="block text-xs text-muted-foreground">
									默认只采样核心问法；扩展问法不用于常规高频监测，选择后会记录在批次上。
								</span>
							</span>
						</label>
					)}
					<fieldset className="flex flex-col gap-2">
						<legend className="mb-1 text-sm font-medium">采样目标</legend>
						{automatic.length === 0 && <p className="text-sm text-muted-foreground">没有可自动采样的目标。</p>}
						{automatic.map((target) => (
							<label key={target.id} className="flex items-start gap-2 text-sm" htmlFor={`batch-target-${target.id}`}>
								<Checkbox
									id={`batch-target-${target.id}`}
									disabled={!target.runnable}
									checked={selected.includes(target.id)}
									onCheckedChange={(checked) =>
										setSelected((prev) => (checked ? [...prev, target.id] : prev.filter((id) => id !== target.id)))
									}
								/>
								<span className="flex flex-1 flex-wrap items-center gap-2">
									<span>
										{GEO_PLATFORM_LABELS[target.platform]} · {GEO_SURFACE_MODE_LABELS[target.surfaceMode]}
									</span>
									<span className="text-xs text-muted-foreground">{target.modelId ?? target.provider}</span>
									<GeoVerificationBadge status={target.verificationStatus} />
									{!target.runnable && <span className="text-xs text-muted-foreground">不可用于自动采样</span>}
								</span>
							</label>
						))}
					</fieldset>
					<div className="flex items-end gap-4">
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="batch-repeat">每个问法 × 目标重复次数</Label>
							<Input
								id="batch-repeat"
								type="number"
								min={1}
								max={10}
								className="w-28"
								value={repeatCount}
								onChange={(e) => setRepeatCount(e.target.value)}
							/>
						</div>
						<p className="pb-2 text-sm text-muted-foreground tabular-nums">
							计划采样 {planned.toLocaleString("zh-CN")} 次
						</p>
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
						<Button type="submit" disabled={create.isPending || !promptSetId || selected.length === 0 || planned === 0}>
							{create.isPending ? "提交中…" : "发起采样"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
