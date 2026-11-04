import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { GEO_PLATFORM_LABELS, type GeoFindingSeverity, type GeoPlatform } from "@workspace/geo-domain";
import { buttonVariants } from "@workspace/ui/components/button";
import {
	type ChartConfig,
	ChartContainer,
	ChartLegend,
	ChartLegendContent,
	ChartTooltip,
	ChartTooltipContent,
} from "@workspace/ui/components/chart";
import { Skeleton } from "@workspace/ui/components/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@workspace/ui/components/table";
import { Tabs, TabsList, TabsTrigger } from "@workspace/ui/components/tabs";
import { cn } from "@workspace/ui/lib/utils";
import { type ReactNode, useState } from "react";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import { useGeoOrganization } from "@/components/geo/sampling/use-geo-organization";
import { GeoEmptyState } from "@/components/geo/shell/empty-state";
import { getSiteCompletenessFn, listTopImprovementsFn } from "@/server/geo/dashboard";
import type { DashboardData, DashboardPlatform } from "@/server/geo/dashboard-core";
import { dashboardKeys, errorText, percent, platformModeLabel, shareLabel } from "./format";

function Muted({ children, className }: { children: ReactNode; className?: string }) {
	return <p className={cn("text-xs text-muted-foreground", className)}>{children}</p>;
}

function NoAnswers() {
	return (
		<GeoEmptyState
			title="最近四周还没有可用的 AI 回答"
			description="监测问题已经设好，但这段时间里还没有成功拿到 AI 的回答。完成一轮提问后，这里会显示结果。"
		/>
	);
}

function ChangeLabel({ change }: { change: number | null }) {
	if (change === null) return <Muted>上一周期没有可比数据</Muted>;
	if (change === 0) return <Muted>和上一周期持平</Muted>;
	const up = change > 0;
	return (
		<p className={cn("text-xs font-medium", up ? "text-emerald-700" : "text-rose-700")}>
			比上一周期{up ? "上升" : "下降"} {Math.abs(change)} 个百分点
		</p>
	);
}

function SmallFigure({ label, value, hint }: { label: string; value: string; hint?: string }) {
	return (
		<div className="flex flex-col gap-0.5">
			<span className="text-xs text-muted-foreground">{label}</span>
			<span className="text-base font-semibold tabular-nums">{value}</span>
			{hint && <span className="text-[11px] text-muted-foreground">{hint}</span>}
		</div>
	);
}

function PlatformTile({ platform }: { platform: DashboardPlatform }) {
	const mention = platform.mentionRate;
	return (
		<div className="flex flex-col gap-4 rounded-lg border bg-background p-5">
			<div className="flex flex-col gap-1">
				<span className="text-sm font-medium">{GEO_PLATFORM_LABELS[platform.platform]}</span>
				<Muted>{platformModeLabel(platform.platform, platform.surfaceMode)}</Muted>
			</div>
			<div className="flex flex-col gap-1">
				<span className="text-4xl font-semibold tracking-tight tabular-nums">{percent(mention)}</span>
				<ChangeLabel change={platform.mentionChange} />
				{mention.status === "OK" && mention.lowSample && (
					<Muted>回答数量较少（{mention.denominator} 条），仅供参考</Muted>
				)}
			</div>
			<div className="grid grid-cols-3 gap-2 border-t pt-3">
				<SmallFigure label="推荐率" value={percent(platform.recommendationRate)} />
				<SmallFigure
					label="平均位次"
					value={platform.position.average === null ? "—" : `第 ${platform.position.average} 位`}
				/>
				<SmallFigure
					label="官网被引用"
					value={platform.ownCitation.provided ? percent(platform.ownCitation.value) : "—"}
					hint={platform.ownCitation.provided ? undefined : "该平台未给出来源"}
				/>
			</div>
		</div>
	);
}

const DEFINITIONS = [
	["曝光率", "AI 成功回答的问题里，提到我们品牌的比例"],
	["推荐率", "AI 成功回答的问题里，明确推荐我们的比例"],
	["平均位次", "提到我们时，我们在回答里是第几个被提到的品牌"],
	["官网被引用", "AI 回答里引用了我们官网页面的比例"],
] as const;

export function ExposureCard({ data }: { data: DashboardData }) {
	if (data.platforms.length === 0) return <NoAnswers />;
	return (
		<div className="flex flex-col gap-4">
			<div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
				{data.platforms.map((platform) => (
					<PlatformTile key={platform.platform} platform={platform} />
				))}
			</div>
			<div className="flex flex-wrap gap-x-6 gap-y-1">
				{DEFINITIONS.map(([term, definition]) => (
					<Muted key={term}>
						<span className="font-medium text-foreground/70">{term}</span>：{definition}
					</Muted>
				))}
				<Muted>每个平台只用一种获取方式统计，“真实产品端”优先；没成功拿到的回答不计入。</Muted>
			</div>
		</div>
	);
}

function PlatformTabs({
	platforms,
	value,
	onChange,
}: {
	platforms: DashboardPlatform[];
	value: GeoPlatform;
	onChange: (platform: GeoPlatform) => void;
}) {
	if (platforms.length < 2) return null;
	return (
		<Tabs value={value} onValueChange={(next) => onChange(next as GeoPlatform)}>
			<TabsList>
				{platforms.map((platform) => (
					<TabsTrigger key={platform.platform} value={platform.platform}>
						{GEO_PLATFORM_LABELS[platform.platform]}
					</TabsTrigger>
				))}
			</TabsList>
		</Tabs>
	);
}

export function CompetitorsCard({ data }: { data: DashboardData }) {
	const [selected, setSelected] = useState<GeoPlatform | null>(null);
	const platform = data.platforms.find((entry) => entry.platform === selected) ?? data.platforms[0];
	if (!platform) return <NoAnswers />;
	if (platform.competitors.length < 2) {
		return (
			<GeoEmptyState
				title="还没有设置竞品"
				description="在“监测问题与竞品”里添加要对比的竞品后，这里会显示我们和它们的排名。"
			/>
		);
	}
	return (
		<div className="flex flex-col gap-3">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<PlatformTabs platforms={data.platforms} value={platform.platform} onChange={setSelected} />
				<Muted>{platformModeLabel(platform.platform, platform.surfaceMode)}</Muted>
			</div>
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead className="w-10">排名</TableHead>
						<TableHead>品牌</TableHead>
						<TableHead className="text-right">曝光率</TableHead>
						<TableHead className="text-right">推荐率</TableHead>
						<TableHead className="w-40">声量占比</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{platform.competitors.map((row, index) => (
						<TableRow key={row.entityId ?? "own"} className={cn(row.isOwn && "bg-sky-50 hover:bg-sky-50")}>
							<TableCell className="tabular-nums text-muted-foreground">{index + 1}</TableCell>
							<TableCell className={cn(row.isOwn && "font-semibold")}>
								{row.name}
								{row.isOwn && <span className="ml-2 text-xs font-normal text-sky-700">我们</span>}
							</TableCell>
							<TableCell className="text-right tabular-nums">{percent(row.mentionRate)}</TableCell>
							<TableCell className="text-right tabular-nums">{percent(row.recommendationRate)}</TableCell>
							<TableCell>
								<div className="flex items-center gap-2">
									<div className="h-1.5 flex-1 rounded-full bg-muted">
										<div
											className={cn("h-1.5 rounded-full", row.isOwn ? "bg-sky-600" : "bg-slate-400")}
											style={{ width: `${Math.round((row.share ?? 0) * 100)}%` }}
										/>
									</div>
									<span className="w-9 text-right text-xs tabular-nums">{shareLabel(row.share)}</span>
								</div>
							</TableCell>
						</TableRow>
					))}
				</TableBody>
			</Table>
			<Muted>
				声量占比：所有被提到的品牌里，每个品牌被提到的次数占总次数的比例。“—”表示该竞品是后来才加入的，暂无可比回答。
			</Muted>
		</div>
	);
}

const LINE_COLORS: Record<GeoPlatform, string> = {
	doubao: "#2563eb",
	deepseek: "#7c3aed",
	yuanbao: "#059669",
	qwen: "#d97706",
};

export function TrendCard({ data }: { data: DashboardData }) {
	const withPoints = data.platforms.filter((platform) => platform.trend.length > 0);
	if (withPoints.length === 0) return <NoAnswers />;
	const weeks = [...new Set(withPoints.flatMap((platform) => platform.trend.map((point) => point.week)))].sort();
	const rows = weeks.map((week) => {
		const row: Record<string, string | number | null> = { week: week.slice(5) };
		for (const platform of withPoints) {
			const point = platform.trend.find((entry) => entry.week === week);
			row[platform.platform] =
				point && point.mentionRate.status === "OK" ? Math.round(point.mentionRate.rate * 1000) / 10 : null;
		}
		return row;
	});
	const config: ChartConfig = Object.fromEntries(
		withPoints.map((platform) => [
			platform.platform,
			{ label: platformModeLabel(platform.platform, platform.surfaceMode), color: LINE_COLORS[platform.platform] },
		]),
	);
	return (
		<div className="flex flex-col gap-2">
			<ChartContainer config={config} className="aspect-auto h-[240px] w-full">
				<LineChart data={rows} margin={{ top: 12, right: 12, left: -12, bottom: 0 }}>
					<CartesianGrid vertical={false} strokeDasharray="3 3" />
					<XAxis dataKey="week" tickLine={false} axisLine={false} tickMargin={8} tick={{ fontSize: 11 }} />
					<YAxis
						domain={[0, 100]}
						ticks={[0, 25, 50, 75, 100]}
						tickLine={false}
						axisLine={false}
						tick={{ fontSize: 11 }}
						tickFormatter={(value) => `${value}%`}
					/>
					<ChartTooltip
						content={
							<ChartTooltipContent formatter={(value, name) => `${config[name as string]?.label ?? name}：${value}%`} />
						}
					/>
					<ChartLegend content={<ChartLegendContent />} />
					{withPoints.map((platform) => (
						<Line
							key={platform.platform}
							dataKey={platform.platform}
							type="monotone"
							stroke={`var(--color-${platform.platform})`}
							strokeWidth={2}
							dot={{ r: 3 }}
							connectNulls={false}
							isAnimationActive={false}
						/>
					))}
				</LineChart>
			</ChartContainer>
			<Muted>按周统计曝光率，横轴为每周一的日期；某周没有成功的回答时该点留空。</Muted>
		</div>
	);
}

const LOW_EXPOSURE = 0.2;

export function RolesCard({ data }: { data: DashboardData }) {
	if (data.platforms.length === 0) return <NoAnswers />;
	if (data.roles.length === 0) {
		return (
			<GeoEmptyState
				title="监测问题还没有标注采购角色"
				description="给每个问题标上是谁在问（如设计院电气工程师、采购负责人）后，这里会显示各角色能否看到我们。"
			/>
		);
	}
	const unseen = data.roles.filter((row) =>
		row.byPlatform.every((cell) => cell.mentionRate.status !== "OK" || cell.mentionRate.rate < LOW_EXPOSURE),
	);
	return (
		<div className="flex flex-col gap-3">
			{unseen.length > 0 && (
				<p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
					{unseen.map((row) => row.role.title).join("、")}提问时，AI 很少提到我们。
				</p>
			)}
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead>采购角色</TableHead>
						{data.platforms.map((platform) => (
							<TableHead key={platform.platform} className="text-right">
								{GEO_PLATFORM_LABELS[platform.platform]}
							</TableHead>
						))}
					</TableRow>
				</TableHeader>
				<TableBody>
					{data.roles.map((row) => (
						<TableRow key={row.role.key}>
							<TableCell>{row.role.title}</TableCell>
							{row.byPlatform.map((cell) => (
								<TableCell
									key={cell.platform}
									className={cn(
										"text-right tabular-nums",
										cell.mentionRate.status === "OK" && cell.mentionRate.rate < LOW_EXPOSURE && "text-amber-700",
									)}
								>
									{percent(cell.mentionRate)}
								</TableCell>
							))}
						</TableRow>
					))}
				</TableBody>
			</Table>
			<Muted>表中是各角色所提问题的曝光率；“—”表示这段时间没有该角色问题的有效回答。</Muted>
		</div>
	);
}

export function ConversationCard({ data }: { data: DashboardData }) {
	const organization = useGeoOrganization();
	const conversation = data.conversation;
	if (!conversation) return <NoAnswers />;
	return (
		<div className="flex flex-col gap-3">
			<div className="flex flex-col gap-1">
				<Muted>
					{platformModeLabel(conversation.platform, conversation.surfaceMode)} ·{" "}
					{new Date(conversation.sampledAt).toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" })}
				</Muted>
				<p className="text-sm font-medium">问：{conversation.question}</p>
			</div>
			<p className="rounded-md bg-muted/50 p-3 text-sm leading-relaxed">
				{conversation.snippet.cutBefore && "…"}
				{conversation.snippet.parts.map((part) =>
					part.mark ? (
						<mark
							key={part.start}
							className={cn(
								"rounded px-0.5",
								part.mark === "own" ? "bg-sky-100 font-semibold text-sky-900" : "bg-amber-100 text-amber-900",
							)}
						>
							{part.text}
						</mark>
					) : (
						<span key={part.start}>{part.text}</span>
					),
				)}
				{conversation.snippet.cutAfter && "…"}
			</p>
			<div className="flex flex-wrap items-center justify-between gap-2">
				<Muted>
					{conversation.brandMentioned ? "这段回答提到了我们" : "这段回答没有提到我们"}
					{conversation.competitorNames.length > 0 && `，提到了 ${conversation.competitorNames.join("、")}`}
				</Muted>
				<Link
					to="/app/org/$org/geo/console"
					params={{ org: organization.slug }}
					search={{ observationId: conversation.observationId }}
					className={buttonVariants({ variant: "outline", size: "sm" })}
				>
					查看完整对话
				</Link>
			</div>
		</div>
	);
}

export function ImprovementsCard() {
	const organization = useGeoOrganization();
	const query = useQuery({
		queryKey: dashboardKeys.improvements(organization.id),
		queryFn: () => listTopImprovementsFn({ data: { organizationId: organization.id } }),
	});
	if (query.error) return <p className="text-sm text-destructive">{errorText(query.error)}</p>;
	if (!query.data) return <Skeleton className="h-32 w-full" />;
	return (
		<div className="flex flex-col gap-3">
			{query.data.length === 0 ? (
				<GeoEmptyState
					title="暂时没有待处理的提升建议"
					description="系统分析完最新的 AI 回答后，会在这里列出最值得先做的三件事。"
				/>
			) : (
				<ol className="flex flex-col gap-3">
					{query.data.map((item, index) => (
						<li key={item.id} className="flex gap-3">
							<span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-sky-100 text-xs font-semibold text-sky-800">
								{index + 1}
							</span>
							<div className="flex min-w-0 flex-col gap-0.5">
								<span className="text-sm font-medium">{item.title}</span>
								<span className="line-clamp-2 text-xs text-muted-foreground">{item.summary}</span>
							</div>
						</li>
					))}
				</ol>
			)}
			<Link
				to="/app/org/$org/geo/recommendations"
				params={{ org: organization.slug }}
				className={cn(buttonVariants({ variant: "outline", size: "sm" }), "self-start")}
			>
				查看全部建议
			</Link>
		</div>
	);
}

const SEVERITY_LABELS: [GeoFindingSeverity, string, string][] = [
	["HIGH", "严重问题", "text-rose-700"],
	["MEDIUM", "一般问题", "text-amber-700"],
	["LOW", "小问题", "text-foreground"],
];

export function SiteCard() {
	const organization = useGeoOrganization();
	const query = useQuery({
		queryKey: dashboardKeys.site(organization.id),
		queryFn: () => getSiteCompletenessFn({ data: { organizationId: organization.id } }),
	});
	if (query.error) return <p className="text-sm text-destructive">{errorText(query.error)}</p>;
	if (!query.data) return <Skeleton className="h-32 w-full" />;
	const { openFindings, contentGaps } = query.data;
	const findingTotal = Object.values(openFindings).reduce((sum, value) => sum + value, 0);
	if (findingTotal === 0 && contentGaps.total === 0) {
		return (
			<GeoEmptyState
				title="官网暂时没有待处理的问题"
				description="如果还没有检查过官网，添加官网地址并完成一次检查后，这里会列出缺失的内容和需要修复的问题。"
			/>
		);
	}
	return (
		<div className="flex flex-col gap-4">
			<div className="grid grid-cols-3 gap-2">
				{SEVERITY_LABELS.map(([severity, label, tone]) => (
					<div key={severity} className="flex flex-col gap-0.5 rounded-md border p-3">
						<span className="text-xs text-muted-foreground">{label}</span>
						<span className={cn("text-2xl font-semibold tabular-nums", tone)}>{openFindings[severity]}</span>
					</div>
				))}
			</div>
			<div className="flex flex-col gap-1.5">
				<span className="text-sm font-medium">官网缺少的内容（{contentGaps.total}）</span>
				{contentGaps.items.length === 0 ? (
					<Muted>暂未发现明显缺少的内容。</Muted>
				) : (
					<ul className="flex flex-col gap-1 text-sm">
						{contentGaps.items.map((item) => (
							<li key={item.id} className="truncate">
								· {item.title}
							</li>
						))}
					</ul>
				)}
			</div>
			<Muted>
				问题来自对官网页面的自动检查；缺少的内容来自 AI 回答里竞品被引用、而我们官网没有的资料（如产品手册、交付案例）。
			</Muted>
		</div>
	);
}

export function SamplesCard({ data }: { data: DashboardData }) {
	return (
		<div className="flex flex-col gap-2 text-sm">
			<p>
				统计时间：{data.period.from} 至 {data.period.to}
				<span className="text-muted-foreground">
					（对比上一周期 {data.previousPeriod.from} 至 {data.previousPeriod.to}）
				</span>
			</p>
			<p>
				监测问题：
				{data.promptSet ? `${data.promptSet.name}（第 ${data.promptSet.version} 版）` : "尚未确定"}
			</p>
			{data.platforms.length > 0 && (
				<ul className="flex flex-col gap-1">
					{data.platforms.map((platform) => (
						<li key={platform.platform} className="text-muted-foreground">
							{platformModeLabel(platform.platform, platform.surfaceMode)}：{platform.evaluated} 条有效回答
							{platform.notCounted > 0 && `，${platform.notCounted} 次未成功获取（不计入）`}
						</li>
					))}
				</ul>
			)}
			<Muted>
				真实产品端：在平台的网页或 App
				里实际提问；人工记录：人工提问后上传截图；模型接口：通过平台的模型接口提问，结果可能与产品端不同。
			</Muted>
		</div>
	);
}
