import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@workspace/ui/components/table";
import type { GeoBuyerRole, GeoRoleCoverage } from "@/server/geo/prompts-core";

export function RolesPanel({ roles, coverage }: { roles: GeoBuyerRole[]; coverage: GeoRoleCoverage[] }) {
	const byRole = new Map(coverage.map((entry) => [entry.buyerRoleId, entry]));
	const unassigned = byRole.get(null);

	return (
		<div className="flex flex-col gap-3">
			<p className="text-sm text-muted-foreground">
				六类买方角色为默认种子，排序即优先级。“已审核核心问法”统计入选基线或已冻结的核心问法，用于确认高优先角色已被覆盖。
			</p>
			<div className="rounded-lg border">
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead className="w-16">优先级</TableHead>
							<TableHead>角色</TableHead>
							<TableHead>代码</TableHead>
							<TableHead className="text-right">核心问法</TableHead>
							<TableHead className="text-right">已审核核心问法</TableHead>
							<TableHead className="text-right">扩展问法</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{roles.map((role) => {
							const entry = byRole.get(role.id);
							return (
								<TableRow key={role.id}>
									<TableCell className="tabular-nums">{role.priority}</TableCell>
									<TableCell className="font-medium">{role.title}</TableCell>
									<TableCell className="font-mono text-xs">{role.code}</TableCell>
									<TableCell className="text-right tabular-nums">{entry?.core ?? 0}</TableCell>
									<TableCell
										className={`text-right tabular-nums ${(entry?.coreReviewed ?? 0) === 0 ? "text-amber-700" : ""}`}
									>
										{entry?.coreReviewed ?? 0}
									</TableCell>
									<TableCell className="text-right tabular-nums">{entry?.extended ?? 0}</TableCell>
								</TableRow>
							);
						})}
					</TableBody>
				</Table>
			</div>
			{unassigned && unassigned.core + unassigned.extended > 0 && (
				<p className="text-sm text-amber-700">
					另有 {unassigned.core + unassigned.extended} 条问法未指定买方角色，提交审核前需要补充。
				</p>
			)}
		</div>
	);
}
