import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { GeoSiteQaVerdict } from "@workspace/geo-domain";
import { Alert, AlertDescription } from "@workspace/ui/components/alert";
import { Button } from "@workspace/ui/components/button";
import { Card, CardContent, CardHeader } from "@workspace/ui/components/card";
import { Input } from "@workspace/ui/components/input";
import { Skeleton } from "@workspace/ui/components/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@workspace/ui/components/table";
import { cn } from "@workspace/ui/lib/utils";
import { useState } from "react";
import { GeoEmptyState } from "@/components/geo/shell/empty-state";
import { GeoStatusBadge } from "@/components/geo/shell/status-badge";
import { useGeoViewer } from "@/components/geo/shell/use-geo-viewer";
import { createQaSampleFn, getQaSampleFn, labelQaItemFn, listQaSamplesFn } from "@/server/geo/site";
import type { SiteSourceView } from "@/server/geo/site-core";
import {
	errorMessage,
	formatDateTime,
	formatPercent,
	QA_FIELD_LABELS,
	QA_VERDICT_LABELS,
	siteQueryKeys,
} from "./site-labels";

const TARGET = 0.9;
const VERDICTS: GeoSiteQaVerdict[] = ["CORRECT", "INCORRECT", "NOT_APPLICABLE"];

function AccuracyBadge({ accuracy }: { accuracy: number | null }) {
	if (accuracy === null) return <GeoStatusBadge label="未标注" />;
	return (
		<GeoStatusBadge label={`准确率 ${formatPercent(accuracy)}`} tone={accuracy >= TARGET ? "success" : "danger"} />
	);
}

function SampleDetail({
	organizationId,
	orgSlug,
	sampleId,
}: {
	organizationId: string;
	orgSlug: string;
	sampleId: string;
}) {
	const viewer = useGeoViewer();
	const queryClient = useQueryClient();
	const [notes, setNotes] = useState<Record<string, string>>({});
	const [error, setError] = useState<string | null>(null);
	const detail = useQuery({
		queryKey: siteQueryKeys.qaSample(organizationId, sampleId),
		queryFn: () => getQaSampleFn({ data: { organizationId, sampleId } }),
	});
	const label = useMutation({
		mutationFn: (input: { itemId: string; verdict: GeoSiteQaVerdict }) =>
			labelQaItemFn({ data: { organizationId, ...input, note: notes[input.itemId] || null } }),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: siteQueryKeys.all }),
		onError: (failure) => setError(errorMessage(failure)),
	});

	if (detail.isLoading || !detail.data) return <Skeleton className="h-64 w-full" />;
	const { items, accuracy, byField } = detail.data;
	const pages = [...new Map(items.map((item) => [item.pageVersionId, item])).values()];
	const canLabel = viewer.can("site.crawl");

	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-wrap items-center gap-3 text-sm">
				<AccuracyBadge accuracy={accuracy.accuracy} />
				<span>
					正确 {accuracy.correct}，错误 {accuracy.incorrect}，不适用 {accuracy.notApplicable}，待标注 {accuracy.pending}
				</span>
				<span className="text-muted-foreground">验收要求关键字段准确率 ≥ 90%</span>
			</div>
			<div className="rounded-lg border">
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>字段</TableHead>
							<TableHead>正确</TableHead>
							<TableHead>错误</TableHead>
							<TableHead>不适用</TableHead>
							<TableHead>准确率</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{Object.entries(byField).map(([field, stats]) => (
							<TableRow key={field}>
								<TableCell>{QA_FIELD_LABELS[field] ?? field}</TableCell>
								<TableCell className="tabular-nums">{stats.correct}</TableCell>
								<TableCell className="tabular-nums">{stats.incorrect}</TableCell>
								<TableCell className="tabular-nums">{stats.notApplicable}</TableCell>
								<TableCell>
									<AccuracyBadge accuracy={stats.accuracy} />
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			</div>
			{error && (
				<Alert variant="destructive">
					<AlertDescription>{error}</AlertDescription>
				</Alert>
			)}
			{pages.map((pageItem) => (
				<Card key={pageItem.pageVersionId}>
					<CardHeader className="pb-2">
						<Link
							to="/app/org/$org/geo/site-pages/$id"
							params={{ org: orgSlug, id: pageItem.pageId }}
							className="font-medium underline-offset-4 hover:underline"
						>
							{pageItem.title ?? pageItem.url}
						</Link>
						<span className="text-xs text-muted-foreground">{pageItem.url}</span>
					</CardHeader>
					<CardContent className="flex flex-col gap-2">
						{items
							.filter((item) => item.pageVersionId === pageItem.pageVersionId)
							.map((item) => (
								<div key={item.id} className="grid gap-2 rounded-md border p-2 md:grid-cols-[8rem_1fr_auto]">
									<div className="text-sm font-medium">{QA_FIELD_LABELS[item.fieldPath] ?? item.fieldPath}</div>
									<div className="whitespace-pre-wrap break-all text-sm text-muted-foreground">
										{item.extractedValue ?? "（未抽取到）"}
									</div>
									<div className="flex flex-col items-end gap-1">
										<div className="flex gap-1">
											{VERDICTS.map((verdict) => (
												<Button
													key={verdict}
													size="sm"
													variant={item.verdict === verdict ? "default" : "outline"}
													disabled={!canLabel || label.isPending}
													className={cn(
														item.verdict === verdict && verdict === "INCORRECT" && "bg-red-600 hover:bg-red-600/90",
													)}
													onClick={() => label.mutate({ itemId: item.id, verdict })}
												>
													{QA_VERDICT_LABELS[verdict]}
												</Button>
											))}
										</div>
										{canLabel && (
											<Input
												className="h-8 w-56"
												placeholder={item.note ?? "备注（可选）"}
												value={notes[item.id] ?? ""}
												onChange={(event) => setNotes((current) => ({ ...current, [item.id]: event.target.value }))}
											/>
										)}
									</div>
								</div>
							))}
					</CardContent>
				</Card>
			))}
		</div>
	);
}

/** Random spot check of parsed pages: at least 30, all of them when fewer, labelled field by field. */
export function QualitySample({
	organizationId,
	orgSlug,
	source,
}: {
	organizationId: string;
	orgSlug: string;
	source: SiteSourceView;
}) {
	const viewer = useGeoViewer();
	const queryClient = useQueryClient();
	const [selected, setSelected] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const samples = useQuery({
		queryKey: siteQueryKeys.qaSamples(organizationId, source.id),
		queryFn: () => listQaSamplesFn({ data: { organizationId, siteId: source.id } }),
	});
	const create = useMutation({
		mutationFn: () => createQaSampleFn({ data: { organizationId, siteId: source.id } }),
		onSuccess: (sample) => {
			setSelected(sample.id);
			setError(null);
			queryClient.invalidateQueries({ queryKey: siteQueryKeys.all });
		},
		onError: (failure) => setError(errorMessage(failure)),
	});
	const active = selected ?? samples.data?.[0]?.id ?? null;

	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<p className="text-sm text-muted-foreground">
					从已解析的有效页面中随机抽取不少于 30 页（不足则全检），逐字段人工判定对错。抽样种子会保存，可复现。
				</p>
				{viewer.can("site.crawl") && (
					<Button size="sm" disabled={create.isPending} onClick={() => create.mutate()}>
						{create.isPending ? "抽样中…" : "新建抽检"}
					</Button>
				)}
			</div>
			{error && (
				<Alert variant="destructive">
					<AlertDescription>{error}</AlertDescription>
				</Alert>
			)}
			{samples.isLoading ? (
				<Skeleton className="h-24 w-full" />
			) : (samples.data ?? []).length === 0 ? (
				<GeoEmptyState title="还没有抽检记录" />
			) : (
				<div className="flex flex-wrap gap-2">
					{(samples.data ?? []).map((sample) => (
						<button
							type="button"
							key={sample.id}
							onClick={() => setSelected(sample.id)}
							className={cn(
								"flex flex-col items-start gap-1 rounded-md border px-3 py-2 text-left text-sm",
								sample.id === active && "border-primary",
							)}
						>
							<span>
								{formatDateTime(sample.createdAt)} · {sample.sampleSize}/{sample.population} 页
							</span>
							<span className="flex items-center gap-2">
								<AccuracyBadge accuracy={sample.accuracy.accuracy} />
								<span className="text-xs text-muted-foreground">
									{sample.status === "COMPLETED" ? "已完成" : `待标注 ${sample.accuracy.pending}`}
								</span>
							</span>
						</button>
					))}
				</div>
			)}
			{active && <SampleDetail organizationId={organizationId} orgSlug={orgSlug} sampleId={active} />}
		</div>
	);
}
