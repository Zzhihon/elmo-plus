import { Button } from "@workspace/ui/components/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@workspace/ui/components/table";
import type { ReactNode } from "react";
import { GeoEmptyState } from "./empty-state";

export interface GeoTableColumn<T> {
	key: string;
	header: ReactNode;
	cell: (row: T) => ReactNode;
	className?: string;
}

/** `page` is one-based, matching the `pagination` block every `/api/v1/geo` list answers with. */
export function GeoPaginatedTable<T>({
	columns,
	rows,
	rowKey,
	page,
	totalPages,
	total,
	onPageChange,
	empty,
}: {
	columns: GeoTableColumn<T>[];
	rows: T[];
	rowKey: (row: T) => string;
	page: number;
	totalPages: number;
	total: number;
	onPageChange: (page: number) => void;
	empty?: ReactNode;
}) {
	if (rows.length === 0 && total === 0) return <>{empty ?? <GeoEmptyState />}</>;

	return (
		<div className="flex flex-col gap-3">
			<div className="rounded-lg border">
				<Table>
					<TableHeader>
						<TableRow>
							{columns.map((column) => (
								<TableHead key={column.key} className={column.className}>
									{column.header}
								</TableHead>
							))}
						</TableRow>
					</TableHeader>
					<TableBody>
						{rows.map((row) => (
							<TableRow key={rowKey(row)}>
								{columns.map((column) => (
									<TableCell key={column.key} className={column.className}>
										{column.cell(row)}
									</TableCell>
								))}
							</TableRow>
						))}
					</TableBody>
				</Table>
			</div>
			<div className="flex items-center justify-between text-sm text-muted-foreground">
				<span className="tabular-nums">
					共 {total.toLocaleString("zh-CN")} 条，第 {page} / {Math.max(totalPages, 1)} 页
				</span>
				<div className="flex items-center gap-2">
					<Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>
						上一页
					</Button>
					<Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => onPageChange(page + 1)}>
						下一页
					</Button>
				</div>
			</div>
		</div>
	);
}
