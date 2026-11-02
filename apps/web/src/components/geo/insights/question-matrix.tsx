import { GEO_PLATFORM_LABELS, GEO_SURFACE_MODE_LABELS } from "@workspace/geo-domain";
import type { CompetitorRef, Gap, Insights, PromptCellState } from "@workspace/geo-reports";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@workspace/ui/components/table";
import { GeoEmptyState } from "@/components/geo/shell/empty-state";
import { type GeoBadgeTone, GeoStatusBadge } from "@/components/geo/shell/status-badge";
import { CreateTaskFromEvidence } from "@/components/geo/tasks/create-task-from-evidence";
import { type EvidenceFilter, EvidenceLink } from "./metric-figure";

const STATE: Record<PromptCellState, { label: string; tone: GeoBadgeTone }> = {
	STABLE: { label: "稳定提及", tone: "success" },
	GAP: { label: "缺口", tone: "danger" },
	INSUFFICIENT: { label: "样本不足", tone: "warning" },
	NO_DATA: { label: "数据不足", tone: "neutral" },
};

/**
 * Questions × platform and surface mode: mentions over evaluated valid samples in the
 * window, with each question's standing in that cell's latest round.
 */
export function GeoQuestionMatrix({
	insights,
	filter,
}: {
	insights: Insights;
	filter: Omit<EvidenceFilter, "platform" | "surfaceMode" | "promptId">;
}) {
	if (insights.prompts.length === 0) return <GeoEmptyState title="当前条件下没有问法样本" />;
	return (
		<div className="overflow-x-auto rounded-lg border">
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead className="min-w-64">问法</TableHead>
						<TableHead>优先级</TableHead>
						{insights.cells.map((cell) => (
							<TableHead key={`${cell.platform}-${cell.surfaceMode}`} className="min-w-36">
								{GEO_PLATFORM_LABELS[cell.platform]}
								<div className="text-xs font-normal text-muted-foreground">
									{GEO_SURFACE_MODE_LABELS[cell.surfaceMode]}
								</div>
							</TableHead>
						))}
					</TableRow>
				</TableHeader>
				<TableBody>
					{insights.prompts.map((row) => (
						<TableRow key={row.promptId}>
							<TableCell className="max-w-md whitespace-normal">{row.questionText}</TableCell>
							<TableCell>{row.priority ?? "—"}</TableCell>
							{row.cells.map((cell) => (
								<TableCell key={`${cell.platform}-${cell.surfaceMode}`}>
									<div className="flex flex-col items-start gap-1">
										<EvidenceLink
											filter={{
												...filter,
												platform: cell.platform,
												surfaceMode: cell.surfaceMode,
												promptId: row.promptId,
											}}
											className="tabular-nums"
										>
											{cell.evaluated === 0 ? "—" : `提及 ${cell.mentioned}/${cell.evaluated}`}
										</EvidenceLink>
										{cell.latestRound && (
											<GeoStatusBadge
												label={`${STATE[cell.latestRound.state].label} ${cell.latestRound.mentioned}/${cell.latestRound.evaluated}`}
												tone={STATE[cell.latestRound.state].tone}
											/>
										)}
									</div>
								</TableCell>
							))}
						</TableRow>
					))}
				</TableBody>
			</Table>
		</div>
	);
}

/** Questions the brand is not stably named for in a cell's latest round, highest priority first, each one a task away. */
export function GeoGapList({
	gaps,
	competitors,
	promptSetId,
	limit,
}: {
	gaps: Gap[];
	competitors: CompetitorRef[];
	promptSetId: string | null;
	limit?: number;
}) {
	const names = new Map(competitors.map((competitor) => [competitor.entityId, competitor.name]));
	const shown = limit ? gaps.slice(0, limit) : gaps;
	if (shown.length === 0) {
		return <GeoEmptyState title="没有缺口" description="最新一轮中，每个样本充足的问法都稳定提及了品牌。" />;
	}
	return (
		<div className="rounded-lg border">
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead>问法</TableHead>
						<TableHead>优先级</TableHead>
						<TableHead>平台 / 方式</TableHead>
						<TableHead>最新一轮提及</TableHead>
						<TableHead>出现的竞品</TableHead>
						<TableHead className="text-right">操作</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{shown.map((gap) => (
						<TableRow key={`${gap.promptId}-${gap.platform}-${gap.surfaceMode}`}>
							<TableCell className="max-w-md whitespace-normal">{gap.questionText}</TableCell>
							<TableCell>{gap.priority ?? "—"}</TableCell>
							<TableCell className="whitespace-nowrap">
								{GEO_PLATFORM_LABELS[gap.platform]} · {GEO_SURFACE_MODE_LABELS[gap.surfaceMode]}
							</TableCell>
							<TableCell className="tabular-nums">
								{gap.mentioned}/{gap.evaluated}
							</TableCell>
							<TableCell className="max-w-48 whitespace-normal text-sm">
								{gap.competitorIds.map((id) => names.get(id) ?? id).join("、") || "—"}
							</TableCell>
							<TableCell className="text-right">
								<CreateTaskFromEvidence
									sourceKind="OBSERVATION"
									sourceRef={`gap:${promptSetId ?? "none"}:${gap.promptId}:${gap.platform}:${gap.surfaceMode}`}
									evidence={{ observationIds: gap.observationIds }}
									promptId={gap.promptId}
									defaultTitle={`补齐缺口：${gap.questionText}`.slice(0, 120)}
									defaultKind="SELECTION_GUIDE"
									defaultPriority={gap.priority ?? undefined}
									recommendedAction={`在${GEO_PLATFORM_LABELS[gap.platform]}（${GEO_SURFACE_MODE_LABELS[gap.surfaceMode]}）最新一轮中，品牌仅在 ${gap.mentioned}/${gap.evaluated} 个有效样本中被提及。补充可核实的官网内容后按相同条件复测。`}
									label="创建工单"
									size="sm"
									variant="outline"
								/>
							</TableCell>
						</TableRow>
					))}
				</TableBody>
			</Table>
		</div>
	);
}
