import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Alert, AlertDescription } from "@workspace/ui/components/alert";
import { Button } from "@workspace/ui/components/button";
import { Label } from "@workspace/ui/components/label";
import { Progress } from "@workspace/ui/components/progress";
import { Skeleton } from "@workspace/ui/components/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@workspace/ui/components/table";
import { Textarea } from "@workspace/ui/components/textarea";
import { useState } from "react";
import { GeoEmptyState } from "@/components/geo/shell/empty-state";
import { GeoStatusBadge } from "@/components/geo/shell/status-badge";
import { useGeoViewer } from "@/components/geo/shell/use-geo-viewer";
import { getKeyUrlCoverageFn, setKeyUrlsFn } from "@/server/geo/site";
import type { SiteSourceView } from "@/server/geo/site-core";
import { errorMessage, formatDateTime, formatPercent, PAGE_STATUS_LABELS, siteQueryKeys } from "./site-labels";

function coverageBadge(entry: { status: string | null; parsed: boolean }) {
	if (!entry.status) return <GeoStatusBadge label="未发现" tone="danger" />;
	if (entry.status !== "ACTIVE") {
		return (
			<GeoStatusBadge
				label={PAGE_STATUS_LABELS[entry.status as keyof typeof PAGE_STATUS_LABELS] ?? entry.status}
				tone="danger"
			/>
		);
	}
	if (!entry.parsed) return <GeoStatusBadge label="已发现，未解析成功" tone="warning" />;
	return <GeoStatusBadge label="已覆盖" tone="success" />;
}

/** PRD 3.11 acceptance: every key URL the customer confirmed is found and parsed in the first round. */
export function KeyUrlCoverage({
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
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(source.keyUrls.join("\n"));
	const [error, setError] = useState<string | null>(null);
	const coverage = useQuery({
		queryKey: siteQueryKeys.coverage(organizationId, source.id),
		queryFn: () => getKeyUrlCoverageFn({ data: { organizationId, siteId: source.id } }),
	});
	const save = useMutation({
		mutationFn: () =>
			setKeyUrlsFn({
				data: {
					organizationId,
					siteId: source.id,
					urls: draft
						.split("\n")
						.map((line) => line.trim())
						.filter(Boolean),
				},
			}),
		onSuccess: () => {
			setEditing(false);
			setError(null);
			queryClient.invalidateQueries({ queryKey: siteQueryKeys.all });
		},
		onError: (failure) => setError(errorMessage(failure)),
	});

	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-wrap items-center justify-between gap-3">
				{coverage.data && coverage.data.total > 0 ? (
					<div className="flex min-w-64 flex-1 flex-col gap-1">
						<div className="text-sm">
							重点网址覆盖率 <span className="font-semibold tabular-nums">{formatPercent(coverage.data.ratio)}</span>（
							{coverage.data.covered}/{coverage.data.total}），验收要求 100%
						</div>
						<Progress value={(coverage.data.ratio ?? 0) * 100} />
					</div>
				) : (
					<div className="text-sm text-muted-foreground">尚未录入客户确认的重点网址清单。</div>
				)}
				{viewer.can("site.manage") && !editing && (
					<Button size="sm" variant="outline" onClick={() => setEditing(true)}>
						编辑重点网址清单
					</Button>
				)}
			</div>
			{editing && (
				<div className="grid gap-2">
					<Label htmlFor="key-urls">重点网址（每行一个，必须在授权域名内）</Label>
					<Textarea
						id="key-urls"
						rows={10}
						className="font-mono text-xs"
						value={draft}
						onChange={(event) => setDraft(event.target.value)}
					/>
					{error && (
						<Alert variant="destructive">
							<AlertDescription>{error}</AlertDescription>
						</Alert>
					)}
					<div className="flex gap-2">
						<Button size="sm" disabled={save.isPending} onClick={() => save.mutate()}>
							保存清单
						</Button>
						<Button size="sm" variant="outline" onClick={() => setEditing(false)}>
							取消
						</Button>
					</div>
				</div>
			)}
			{coverage.isLoading ? (
				<Skeleton className="h-40 w-full" />
			) : !coverage.data || coverage.data.statuses.length === 0 ? (
				<GeoEmptyState title="暂无重点网址" description="录入客户确认的页面清单后，这里会逐条显示是否已发现和解析。" />
			) : (
				<div className="rounded-lg border">
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>重点网址</TableHead>
								<TableHead>覆盖情况</TableHead>
								<TableHead>最后发现</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{coverage.data.statuses.map((entry) => (
								<TableRow key={entry.url}>
									<TableCell className="max-w-lg truncate">
										{entry.pageId ? (
											<Link
												to="/app/org/$org/geo/site-pages/$id"
												params={{ org: orgSlug, id: entry.pageId }}
												className="underline"
											>
												{entry.url}
											</Link>
										) : (
											entry.url
										)}
									</TableCell>
									<TableCell>{coverageBadge(entry)}</TableCell>
									<TableCell>{formatDateTime(entry.lastSeenAt)}</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</div>
			)}
		</div>
	);
}
