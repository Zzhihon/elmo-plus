import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { GeoCrawlItemOutcome } from "@workspace/geo-domain";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@workspace/ui/components/dialog";
import { Skeleton } from "@workspace/ui/components/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@workspace/ui/components/table";
import {
	CrawlStatusBadge,
	formatDateTime,
	formatNumber,
	formatPercent,
	OUTCOME_LABELS,
	siteQueryKeys,
} from "@/components/geo/site-pages/site-labels";
import { getCrawlRunFn } from "@/server/geo/site";

const ACTIVE = new Set(["QUEUED", "RUNNING"]);

function Stat({ label, value }: { label: string; value: string }) {
	return (
		<div className="rounded-md border p-3">
			<div className="text-xs text-muted-foreground">{label}</div>
			<div className="mt-1 text-lg font-semibold tabular-nums">{value}</div>
		</div>
	);
}

type CrawlRunDetail = Awaited<ReturnType<typeof getCrawlRunFn>>;
type RunMeta = CrawlRunDetail["run"]["meta"];

function robotsSummary(meta: RunMeta): string {
	const robots = meta?.robots;
	if (!robots) return "尚未读取";
	if (robots.source === "NOT_FOUND") return `未提供（HTTP ${robots.httpStatus ?? "-"}），按规范视为无限制`;
	if (robots.source === "UNAVAILABLE") return "无法获取，暂停全站采集";
	const others = Object.keys(meta?.robotsByOrigin ?? {}).length - 1;
	const extra = others > 0 ? `；另有 ${others} 个站点来源按各自的 robots.txt 执行` : "";
	return `已读取，${robots.ruleCount} 条规则${extra}`;
}

function sitemapSummary(meta: RunMeta, hasSeedOverride: boolean): string {
	const sitemap = meta?.sitemap;
	if (sitemap) {
		return sitemap.urls > 0
			? `${sitemap.urls} 个网址，来自 ${sitemap.files.length} 个文件`
			: "未找到，改为遍历站内链接与分页";
	}
	return hasSeedOverride ? "指定网址任务不读取站点地图" : "尚未读取";
}

function DiscoverySummary({ meta, hasSeedOverride }: { meta: RunMeta; hasSeedOverride: boolean }) {
	return (
		<div className="grid gap-2 text-sm sm:grid-cols-2">
			<div>
				<span className="text-muted-foreground">robots.txt：</span>
				{robotsSummary(meta)}
			</div>
			<div>
				<span className="text-muted-foreground">站点地图：</span>
				{sitemapSummary(meta, hasSeedOverride)}
			</div>
			{meta?.nofollowSkipped ? (
				<div>
					<span className="text-muted-foreground">nofollow 未跟随：</span>
					{meta.nofollowSkipped}
				</div>
			) : null}
			{meta?.outOfScopeSamples?.length ? (
				<div>
					<span className="text-muted-foreground">范围外链接（未抓取）样例：</span>
					{meta.outOfScopeSamples.slice(0, 3).join("、")}
				</div>
			) : null}
		</div>
	);
}

function ProgressStats({ progress }: { progress: CrawlRunDetail["progress"] }) {
	return (
		<div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
			<Stat label="队列中 / 总网址" value={`${formatNumber(progress.queued)} / ${formatNumber(progress.total)}`} />
			<Stat label="成功（新版本 + 未变化 + 重复）" value={formatNumber(progress.succeeded)} />
			<Stat label="新版本" value={formatNumber(progress.newVersions)} />
			<Stat label="未变化" value={formatNumber(progress.unchanged)} />
			<Stat label="失败" value={formatNumber(progress.failed)} />
			<Stat label="跳过" value={formatNumber(progress.skipped)} />
			<Stat label="抓取成功率" value={formatPercent(progress.successRate)} />
			<Stat label="响应 P50 / P95" value={`${progress.p50Ms ?? "—"} / ${progress.p95Ms ?? "—"} ms`} />
		</div>
	);
}

function ItemsTable({ items, orgSlug }: { items: CrawlRunDetail["items"]; orgSlug: string }) {
	return (
		<div className="rounded-lg border">
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead>网址</TableHead>
						<TableHead>结果</TableHead>
						<TableHead>HTTP</TableHead>
						<TableHead>尝试</TableHead>
						<TableHead>说明</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{items.map((item) => (
						<TableRow key={item.id}>
							<TableCell className="max-w-xs truncate">
								{item.pageId ? (
									<Link
										to="/app/org/$org/geo/site-pages/$id"
										params={{ org: orgSlug, id: item.pageId }}
										className="underline"
									>
										{item.url}
									</Link>
								) : (
									item.url
								)}
							</TableCell>
							<TableCell>{item.outcome ? (OUTCOME_LABELS[item.outcome] ?? item.outcome) : item.status}</TableCell>
							<TableCell className="tabular-nums">{item.httpStatus ?? "—"}</TableCell>
							<TableCell className="tabular-nums">{item.attempts}</TableCell>
							<TableCell className="max-w-xs truncate text-muted-foreground">{item.detail ?? ""}</TableCell>
						</TableRow>
					))}
				</TableBody>
			</Table>
		</div>
	);
}

function RunDetailBody({ data, orgSlug }: { data: CrawlRunDetail; orgSlug: string }) {
	return (
		<div className="flex flex-col gap-4">
			{data.run.errorSummary && <p className="text-sm text-amber-800">{data.run.errorSummary}</p>}
			<ProgressStats progress={data.progress} />
			<DiscoverySummary meta={data.run.meta} hasSeedOverride={Boolean(data.run.config.seedUrls)} />
			<div className="flex flex-wrap gap-2 text-xs">
				{Object.entries(data.progress.outcomes).map(([outcome, total]) => (
					<span key={outcome} className="rounded border px-2 py-1">
						{OUTCOME_LABELS[outcome as GeoCrawlItemOutcome] ?? outcome}：{total}
					</span>
				))}
			</div>
			{data.items.length > 0 && <ItemsTable items={data.items} orgSlug={orgSlug} />}
		</div>
	);
}

function runDescription(data: CrawlRunDetail | undefined): string {
	if (!data) return "加载中";
	const mode = data.run.mode === "FULL" ? "全量" : "增量";
	return `${mode}采集 · 创建于 ${formatDateTime(data.run.createdAt)} · 策略 ${data.run.policyVersion}`;
}

export function CrawlRunDialog({
	organizationId,
	orgSlug,
	siteId,
	runId,
	onOpenChange,
}: {
	organizationId: string;
	orgSlug: string;
	siteId: string;
	runId: string | null;
	onOpenChange: (open: boolean) => void;
}) {
	const { data, isLoading } = useQuery({
		queryKey: siteQueryKeys.run(organizationId, runId ?? ""),
		queryFn: () => getCrawlRunFn({ data: { organizationId, siteId, runId: runId as string } }),
		enabled: Boolean(runId),
		refetchInterval: (query) => (query.state.data && ACTIVE.has(query.state.data.run.status) ? 5_000 : false),
	});

	return (
		<Dialog open={Boolean(runId)} onOpenChange={onOpenChange}>
			<DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						采集任务详情 {data && <CrawlStatusBadge status={data.run.status} />}
					</DialogTitle>
					<DialogDescription>{runDescription(data)}</DialogDescription>
				</DialogHeader>
				{isLoading || !data ? <Skeleton className="h-40 w-full" /> : <RunDetailBody data={data} orgSlug={orgSlug} />}
			</DialogContent>
		</Dialog>
	);
}
