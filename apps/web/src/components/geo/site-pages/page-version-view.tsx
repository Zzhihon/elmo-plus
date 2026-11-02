import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@workspace/ui/components/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@workspace/ui/components/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@workspace/ui/components/tabs";
import { cn } from "@workspace/ui/lib/utils";
import { useState } from "react";
import { GeoEmptyState } from "@/components/geo/shell/empty-state";
import { useGeoViewer } from "@/components/geo/shell/use-geo-viewer";
import { getPageVersionFn, getSnapshotViewFn } from "@/server/geo/site";
import { formatDateTime, siteQueryKeys } from "./site-labels";

function fieldText(value: unknown): string {
	if (value === null || value === undefined) return "（未抽取到）";
	if (typeof value === "string") return value;
	if (Array.isArray(value)) {
		return value.map((entry) => (Array.isArray(entry) ? entry.join(" | ") : String(entry))).join("\n");
	}
	return JSON.stringify(value);
}

/**
 * The stored page is shown in a sandbox with no permissions at all, from markup
 * the server has already stripped of script and every external reference.
 */
function SnapshotFrame({ organizationId, versionId }: { organizationId: string; versionId: string }) {
	const snapshot = useQuery({
		queryKey: siteQueryKeys.snapshot(organizationId, versionId),
		queryFn: () => getSnapshotViewFn({ data: { organizationId, versionId } }),
		staleTime: Number.POSITIVE_INFINITY,
	});
	if (snapshot.isLoading) return <Skeleton className="h-96 w-full" />;
	if (snapshot.error) return <GeoEmptyState title="无法加载快照" description={snapshot.error.message} />;
	if (!snapshot.data?.html) {
		return <GeoEmptyState title="附件不在页面中预览" description="请使用下载按钮获取原始文件。" />;
	}
	return (
		<div className="flex flex-col gap-2">
			<div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
				<span>
					采集时间 {formatDateTime(snapshot.data.fetchedAt)}。预览已移除脚本、表单和外部资源，图片以占位符显示。
				</span>
				<a
					className="underline"
					href={`/api/geo-snapshots/${versionId}?organizationId=${encodeURIComponent(organizationId)}`}
					rel="noopener"
				>
					下载原始 HTML
				</a>
			</div>
			<iframe
				title="原始页面快照"
				sandbox=""
				referrerPolicy="no-referrer"
				srcDoc={snapshot.data.html}
				className="h-[70vh] w-full rounded-md border bg-white"
			/>
		</div>
	);
}

type VersionDetail = Awaited<ReturnType<typeof getPageVersionFn>>;
type ParsedDetail = NonNullable<VersionDetail["parsed"]>;
type DiffLineView = NonNullable<VersionDetail["diff"]>["lines"][number];

const DIFF_PREFIX: Record<DiffLineView["op"], string> = { added: "+ ", removed: "- ", same: "  " };

function VersionFacts({ version, parsed }: { version: VersionDetail["version"]; parsed: VersionDetail["parsed"] }) {
	return (
		<dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[8rem_1fr]">
			<dt className="text-muted-foreground">标题</dt>
			<dd>{parsed?.title ?? "—"}</dd>
			<dt className="text-muted-foreground">栏目</dt>
			<dd>{parsed?.categoryLabel ?? parsed?.category ?? "未分类"}</dd>
			<dt className="text-muted-foreground">发布日期</dt>
			<dd>{parsed?.publishedAt ?? "—"}</dd>
			<dt className="text-muted-foreground">描述</dt>
			<dd>{parsed?.metaDescription ?? "—"}</dd>
			<dt className="text-muted-foreground">解析器版本</dt>
			<dd className="font-mono text-xs">{version.parserVersion}</dd>
			<dt className="text-muted-foreground">内容指纹</dt>
			<dd className="font-mono text-xs">{version.contentHash.slice(0, 16)}</dd>
			{parsed?.warnings.length ? (
				<>
					<dt className="text-muted-foreground">提示</dt>
					<dd>{parsed.warnings.join("、")}</dd>
				</>
			) : null}
		</dl>
	);
}

function FieldsTable({ fields }: { fields: ParsedDetail["fields"] }) {
	return (
		<div className="rounded-lg border">
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead>字段</TableHead>
						<TableHead>抽取值</TableHead>
						<TableHead>定位</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{fields.map((field) => (
						<TableRow key={field.path}>
							<TableCell className="align-top">
								<div>{field.label ?? field.path}</div>
								<div className="font-mono text-xs text-muted-foreground">{field.path}</div>
							</TableCell>
							<TableCell className="max-w-xl whitespace-pre-wrap break-all align-top">
								{fieldText(field.value)}
							</TableCell>
							<TableCell className="align-top font-mono text-xs text-muted-foreground">
								{field.locator?.selector ?? "—"}
							</TableCell>
						</TableRow>
					))}
				</TableBody>
			</Table>
		</div>
	);
}

function ParsedTables({ tables }: { tables: ParsedDetail["tables"] }) {
	return (
		<>
			{tables.map((table, index) => (
				<div key={`table-${index.toString()}`} className="overflow-x-auto rounded-lg border">
					<Table>
						<TableBody>
							{table.rows.map((row, rowIndex) => (
								<TableRow key={`row-${rowIndex.toString()}`}>
									{row.map((cell, cellIndex) => (
										<TableCell key={`cell-${cellIndex.toString()}`}>{cell}</TableCell>
									))}
								</TableRow>
							))}
						</TableBody>
					</Table>
				</div>
			))}
		</>
	);
}

function ImageLinks({ images }: { images: ParsedDetail["images"] }) {
	if (images.length === 0) return null;
	return (
		<div className="flex flex-col gap-1 text-sm">
			<span className="text-muted-foreground">图片链接（{images.length}）</span>
			{images.slice(0, 30).map((image) => (
				<span key={image.src} className="break-all font-mono text-xs">
					{image.src}
					{image.alt ? `（${image.alt}）` : ""}
				</span>
			))}
		</div>
	);
}

function ParsedPanel({ detail }: { detail: VersionDetail }) {
	const { version, parsed } = detail;
	return (
		<>
			{version.parseStatus === "FAILED" && (
				<p className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
					解析失败（{version.errorCode}）：{version.parsed?.error ?? "未知原因"}
				</p>
			)}
			<VersionFacts version={version} parsed={parsed} />
			{parsed && parsed.fields.length > 0 && <FieldsTable fields={parsed.fields} />}
			{parsed && <ParsedTables tables={parsed.tables} />}
			{parsed && <ImageLinks images={parsed.images} />}
			<div className="flex flex-col gap-1">
				<span className="text-sm text-muted-foreground">正文</span>
				<pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-md border bg-muted/40 p-3 text-sm">
					{parsed?.text || "（无正文）"}
				</pre>
			</div>
		</>
	);
}

function DiffPanel({ diff, compareTo }: { diff: VersionDetail["diff"]; compareTo: VersionDetail["compareTo"] }) {
	if (!diff || !compareTo) {
		return <GeoEmptyState title="没有可比较的旧版本" description="这是该页面最早的内容版本，或之前的版本解析失败。" />;
	}
	return (
		<div className="flex flex-col gap-2">
			<p className="text-sm text-muted-foreground">
				与 {formatDateTime(compareTo.fetchedAt)} 采集的版本比较
				{diff.truncated ? "（内容过长，只比较前 1500 行）" : ""}
			</p>
			<div className="max-h-[70vh] overflow-auto rounded-md border font-mono text-xs">
				{diff.lines.map((line, index) => (
					<div
						key={`${index.toString()}-${line.op}`}
						className={cn(
							"whitespace-pre-wrap px-3 py-0.5",
							line.op === "added" && "bg-emerald-50 text-emerald-800",
							line.op === "removed" && "bg-red-50 text-red-700 line-through",
						)}
					>
						{DIFF_PREFIX[line.op]}
						{line.text}
					</div>
				))}
			</div>
		</div>
	);
}

export function PageVersionView({
	organizationId,
	pageId,
	versionId,
}: {
	organizationId: string;
	pageId: string;
	versionId: string;
}) {
	const viewer = useGeoViewer();
	const [tab, setTab] = useState("parsed");
	const detail = useQuery({
		queryKey: siteQueryKeys.version(organizationId, versionId),
		queryFn: () => getPageVersionFn({ data: { organizationId, pageId, versionId } }),
	});
	if (detail.isLoading || !detail.data) return <Skeleton className="h-96 w-full" />;
	const canReadSnapshot = viewer.can("site.read_snapshot");

	return (
		<Tabs value={tab} onValueChange={(value) => setTab(String(value))}>
			<TabsList>
				<TabsTrigger value="parsed">解析结果</TabsTrigger>
				<TabsTrigger value="diff">内容差异</TabsTrigger>
				{canReadSnapshot && <TabsTrigger value="snapshot">原始快照</TabsTrigger>}
			</TabsList>
			<TabsContent value="parsed" className="flex flex-col gap-4 pt-4">
				<ParsedPanel detail={detail.data} />
			</TabsContent>
			<TabsContent value="diff" className="pt-4">
				<DiffPanel diff={detail.data.diff} compareTo={detail.data.compareTo} />
			</TabsContent>
			{canReadSnapshot && (
				<TabsContent value="snapshot" className="pt-4">
					{tab === "snapshot" && <SnapshotFrame organizationId={organizationId} versionId={versionId} />}
				</TabsContent>
			)}
		</Tabs>
	);
}
