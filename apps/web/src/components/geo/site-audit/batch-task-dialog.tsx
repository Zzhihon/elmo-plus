import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
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
import { useState } from "react";
import { errorMessage } from "@/components/geo/site-pages/site-labels";
import { geoTaskKeys } from "@/components/geo/tasks/queries";
import { SimpleSelect } from "@/components/geo/tasks/simple-select";
import { createTasksFromFindingsFn } from "@/server/geo/site-audit";
import { siteAuditKeys } from "./labels";

type Mode = "PER_PAGE" | "PER_FINDING" | "MERGED";
type Result = Awaited<ReturnType<typeof createTasksFromFindingsFn>>;

const MODE_OPTIONS: Array<{ value: Mode; label: string }> = [
	{ value: "PER_PAGE", label: "每个页面一张工单" },
	{ value: "PER_FINDING", label: "每条发现一张工单" },
	{ value: "MERGED", label: "合并为一张工单" },
];

const MODE_HELP: Record<Mode, string> = {
	PER_PAGE: "同一页面的发现合并处理。该页面已有未结束的整改工单时，发现会并入那张工单。",
	PER_FINDING: "适合需要不同部门分别处理的问题。",
	MERGED: "适合模板级问题（如全站缺少 canonical），由一次改版统一修复。",
};

export function BatchTaskDialog({
	organizationId,
	orgSlug,
	findingIds,
	open,
	onOpenChange,
	onDone,
}: {
	organizationId: string;
	orgSlug: string;
	findingIds: string[];
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onDone: () => void;
}) {
	const queryClient = useQueryClient();
	const [mode, setMode] = useState<Mode>("PER_PAGE");
	const [result, setResult] = useState<Result | null>(null);
	const create = useMutation({
		mutationFn: () => createTasksFromFindingsFn({ data: { organizationId, input: { findingIds, mode } } }),
		onSuccess: async (data) => {
			setResult(data);
			onDone();
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: siteAuditKeys.all(organizationId) }),
				queryClient.invalidateQueries({ queryKey: geoTaskKeys.all(organizationId) }),
			]);
		},
	});

	function close(next: boolean) {
		onOpenChange(next);
		if (!next) {
			setResult(null);
			create.reset();
		}
	}

	return (
		<Dialog open={open} onOpenChange={close}>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>从审计发现创建优化工单</DialogTitle>
					<DialogDescription>
						已选择 {findingIds.length} 条发现。只有“待处理”的发现会建工单，工单会关联这些发现作为诊断证据。
					</DialogDescription>
				</DialogHeader>
				{result ? (
					<div className="flex flex-col gap-3">
						<ul className="flex flex-col gap-1 text-sm">
							{result.tasks.map((task) => (
								<li key={task.id}>
									<Link to="/app/org/$org/geo/tasks/$id" params={{ org: orgSlug, id: task.id }} className="underline">
										{task.title}
									</Link>
									<span className="ml-2 text-muted-foreground">
										{task.created ? "新建" : "并入已有工单"}，{task.findingIds.length} 条发现
									</span>
								</li>
							))}
						</ul>
						{result.skipped.length > 0 && (
							<p className="text-sm text-muted-foreground">{result.skipped.length} 条发现不是待处理状态，已跳过。</p>
						)}
						<DialogFooter>
							<Button onClick={() => close(false)}>完成</Button>
						</DialogFooter>
					</div>
				) : (
					<div className="flex flex-col gap-4">
						<div className="flex flex-col gap-2">
							<Label htmlFor="batch-mode">建单方式</Label>
							<SimpleSelect
								id="batch-mode"
								value={mode}
								onChange={(value) => value && setMode(value)}
								options={MODE_OPTIONS}
							/>
							<p className="text-sm text-muted-foreground">{MODE_HELP[mode]}</p>
						</div>
						<p className="text-sm text-muted-foreground">
							标题、类型、优先级和建议动作按发现自动填写，目标问法取发现推荐的第一条；创建后可在工单中修改与指派。
						</p>
						{create.error && (
							<Alert variant="destructive">
								<AlertDescription>{errorMessage(create.error)}</AlertDescription>
							</Alert>
						)}
						<DialogFooter>
							<Button variant="outline" onClick={() => close(false)}>
								取消
							</Button>
							<Button onClick={() => create.mutate()} disabled={create.isPending || findingIds.length === 0}>
								{create.isPending ? "创建中…" : "创建工单"}
							</Button>
						</DialogFooter>
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
}
