import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@workspace/ui/components/button";
import { Skeleton } from "@workspace/ui/components/skeleton";
import { useState } from "react";
import { ImportEvidenceDialog } from "@/components/geo/observations/import-dialog";
import { BatchList } from "@/components/geo/sampling/batch-list";
import { CreateBatchDialog } from "@/components/geo/sampling/create-batch-dialog";
import { samplingKeys } from "@/components/geo/sampling/keys";
import { TargetFormDialog } from "@/components/geo/sampling/target-form-dialog";
import { TargetMatrix } from "@/components/geo/sampling/target-matrix";
import { GeoPageFrame } from "@/components/geo/shell/page-frame";
import { useGeoViewer } from "@/components/geo/shell/use-geo-viewer";
import { pageHead } from "@/lib/route-head";
import { listSamplingTargetsFn } from "@/server/geo/sampling";

export const Route = createFileRoute("/_authed/app/org/$org/geo/sampling")({
	staticData: { crumb: "采样中心" },
	head: pageHead({ description: "查看平台、源模式、任务状态与成本预算，发起采样或导入证据。" }),
	component: GeoSamplingPage,
});

function Section({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
	return (
		<section className="flex flex-col gap-3">
			<div>
				<h2 className="text-lg font-semibold">{title}</h2>
				<p className="text-sm text-muted-foreground">{description}</p>
			</div>
			{children}
		</section>
	);
}

function GeoSamplingPage() {
	const { organization } = Route.useRouteContext();
	const viewer = useGeoViewer();
	const [dialog, setDialog] = useState<"batch" | "import" | "target" | null>(null);
	const targets = useQuery({
		queryKey: samplingKeys.targets(organization.id),
		queryFn: () => listSamplingTargetsFn({ data: { organizationId: organization.id } }),
	});
	const close = (open: boolean) => !open && setDialog(null);

	return (
		<GeoPageFrame
			title="采样中心"
			description="查看平台、源模式、任务状态与成本预算，发起采样或导入证据。"
			actions={
				<>
					{viewer.can("target.manage") && (
						<Button variant="outline" onClick={() => setDialog("target")}>
							新增目标
						</Button>
					)}
					{viewer.can("evidence.import") && (
						<Button variant="outline" onClick={() => setDialog("import")}>
							导入证据
						</Button>
					)}
					{viewer.can("sampling.run") && <Button onClick={() => setDialog("batch")}>发起采样</Button>}
				</>
			}
		>
			<Section title="能力矩阵" description="每个平台按源模式分别配置与验证；各源模式的指标分开统计。">
				{targets.data ? <TargetMatrix targets={targets.data} /> : <Skeleton className="h-48 w-full" />}
			</Section>
			<Section
				title="采样批次"
				description="有效率 = 有效样本 / 计划样本；失败、限流和不可用的样本单独列出，不计入分母。"
			>
				<BatchList />
			</Section>
			{dialog === "batch" && <CreateBatchDialog targets={targets.data ?? []} open onOpenChange={close} />}
			{dialog === "import" && <ImportEvidenceDialog open onOpenChange={close} />}
			{dialog === "target" && <TargetFormDialog open onOpenChange={close} />}
		</GeoPageFrame>
	);
}
