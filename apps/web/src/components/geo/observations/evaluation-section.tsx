import {
	GEO_EVALUATION_REVIEW_LABELS,
	GEO_RECOMMENDATION_LABELS,
	type GeoEvaluationReviewStatus,
	type GeoRecommendation,
} from "@workspace/geo-domain";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@workspace/ui/components/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@workspace/ui/components/table";
import { formatDateTime } from "@/components/geo/sampling/format";
import { GeoEvaluationReviewBadge, GeoStatusBadge } from "@/components/geo/shell/status-badge";
import type { ObservationDetail } from "@/server/geo/observations-core";

/**
 * Every evaluation version of an observation, newest first. Review actions are added
 * by the evaluation and review workflow around this list; the observation itself never changes.
 */
export function ObservationEvaluationSection({ observation }: { observation: ObservationDetail }) {
	return (
		<Card>
			<CardHeader>
				<CardTitle>评估版本</CardTitle>
				<CardDescription>
					更正只会追加新的评估版本，原始回答保持不变。
					{!observation.countsInRates && "此样本未取得完整回答，不计入任何比率，也不会被判定为“未提及”。"}
				</CardDescription>
			</CardHeader>
			<CardContent>
				{observation.evaluations.length === 0 ? (
					<p className="text-sm text-muted-foreground">
						{observation.countsInRates || observation.status === "PARTIAL" ? "尚未评估。" : "该样本不参与评估。"}
					</p>
				) : (
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>版本</TableHead>
								<TableHead>结论</TableHead>
								<TableHead>品牌提及</TableHead>
								<TableHead>排名</TableHead>
								<TableHead>置信度</TableHead>
								<TableHead>复核状态</TableHead>
								<TableHead>评估器</TableHead>
								<TableHead>时间</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{observation.evaluations.map((evaluation) => (
								<TableRow key={evaluation.id}>
									<TableCell className="tabular-nums">
										v{evaluation.version}
										{evaluation.isCurrent && <GeoStatusBadge className="ml-2" label="当前" tone="info" />}
									</TableCell>
									<TableCell>
										{GEO_RECOMMENDATION_LABELS[evaluation.recommendation as GeoRecommendation] ??
											evaluation.recommendation}
									</TableCell>
									<TableCell>{evaluation.brandMentioned ? "是" : "否"}</TableCell>
									<TableCell className="tabular-nums">{evaluation.brandRank ?? "—"}</TableCell>
									<TableCell className="tabular-nums">
										{evaluation.confidence === null ? "—" : evaluation.confidence.toFixed(2)}
									</TableCell>
									<TableCell>
										{evaluation.reviewStatus in GEO_EVALUATION_REVIEW_LABELS ? (
											<GeoEvaluationReviewBadge status={evaluation.reviewStatus as GeoEvaluationReviewStatus} />
										) : (
											evaluation.reviewStatus
										)}
									</TableCell>
									<TableCell className="text-xs text-muted-foreground">{evaluation.evaluatorVersion}</TableCell>
									<TableCell className="whitespace-nowrap text-xs">{formatDateTime(evaluation.createdAt)}</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				)}
			</CardContent>
		</Card>
	);
}
