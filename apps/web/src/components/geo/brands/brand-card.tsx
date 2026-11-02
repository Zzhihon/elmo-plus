import { GEO_FACT_STATUS_LABELS, GEO_TERM_KIND_LABELS, type GeoFactStatus } from "@workspace/geo-domain";
import { Badge } from "@workspace/ui/components/badge";
import { Button } from "@workspace/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@workspace/ui/components/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@workspace/ui/components/table";
import { History, Pencil, Plus } from "lucide-react";
import type { ReactNode } from "react";
import { type GeoBadgeTone, GeoStatusBadge } from "@/components/geo/shell/status-badge";
import type { GeoBrandWithProducts, GeoProduct } from "@/server/geo/profile-core";

const FACT_TONES: Record<GeoFactStatus, GeoBadgeTone> = {
	UNVERIFIED: "warning",
	PENDING_REVIEW: "info",
	APPROVED: "success",
	REJECTED: "danger",
};

export function GeoFactStatusBadge({ status }: { status: GeoFactStatus }) {
	return <GeoStatusBadge label={GEO_FACT_STATUS_LABELS[status]} tone={FACT_TONES[status]} />;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="grid grid-cols-[6rem_1fr] gap-2 text-sm">
			<dt className="text-muted-foreground">{label}</dt>
			<dd className="min-w-0 break-words">{children}</dd>
		</div>
	);
}

function TermList({ terms }: { terms: string[] }) {
	if (terms.length === 0) return <span className="text-muted-foreground">—</span>;
	return (
		<div className="flex flex-wrap gap-1.5">
			{terms.map((term) => (
				<Badge key={term} variant="outline">
					{term}
				</Badge>
			))}
		</div>
	);
}

export function BrandCard({
	brand,
	canManage,
	onEdit,
	onToggleStatus,
	onHistory,
	onAddProduct,
	onEditProduct,
	onToggleProduct,
}: {
	brand: GeoBrandWithProducts;
	canManage: boolean;
	onEdit: () => void;
	onToggleStatus: () => void;
	onHistory: () => void;
	onAddProduct: () => void;
	onEditProduct: (product: GeoProduct) => void;
	onToggleProduct: (product: GeoProduct) => void;
}) {
	const disabled = brand.status === "DISABLED";
	return (
		<Card className={disabled ? "opacity-70" : undefined}>
			<CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
				<div className="flex flex-col gap-1.5">
					<CardTitle className="flex flex-wrap items-center gap-2 text-base">
						{brand.displayName}
						{disabled && <GeoStatusBadge label="已停用" />}
						<GeoFactStatusBadge status={brand.factStatus} />
					</CardTitle>
					{brand.legalName && <p className="text-sm text-muted-foreground">{brand.legalName}</p>}
				</div>
				<div className="flex flex-wrap items-center gap-2">
					<Button variant="ghost" size="sm" onClick={onHistory}>
						<History className="size-4" />
						变更历史
					</Button>
					{canManage && (
						<>
							<Button variant="outline" size="sm" onClick={onEdit}>
								<Pencil className="size-4" />
								编辑
							</Button>
							<Button variant="outline" size="sm" onClick={onToggleStatus}>
								{disabled ? "启用" : "停用"}
							</Button>
						</>
					)}
				</div>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				<dl className="grid gap-2 lg:grid-cols-2">
					<Row label="简称">{brand.shortName ?? "—"}</Row>
					<Row label="官网">
						{brand.officialUrl ? (
							<a href={brand.officialUrl} target="_blank" rel="noreferrer noopener" className="underline">
								{brand.officialUrl}
							</a>
						) : (
							"—"
						)}
					</Row>
					<Row label="别名">
						<TermList terms={brand.aliases} />
					</Row>
					<Row label="历史名称">
						<TermList terms={brand.historicalNames} />
					</Row>
					<Row label="域名">
						<TermList terms={brand.domains} />
					</Row>
					<Row label="服务区域">
						<TermList terms={brand.regions} />
					</Row>
				</dl>
				{brand.factNotes.length > 0 && (
					<div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
						<p className="mb-1 font-medium">待客户确认的事实</p>
						<ul className="list-disc space-y-0.5 pl-5">
							{brand.factNotes.map((note) => (
								<li key={note}>{note}</li>
							))}
						</ul>
					</div>
				)}
				<div className="flex flex-col gap-2">
					<div className="flex items-center justify-between">
						<h3 className="text-sm font-medium">产品与型号</h3>
						{canManage && (
							<Button variant="ghost" size="sm" onClick={onAddProduct}>
								<Plus className="size-4" />
								新增产品
							</Button>
						)}
					</div>
					{brand.products.length === 0 ? (
						<p className="text-sm text-muted-foreground">尚未登记产品。</p>
					) : (
						<div className="rounded-lg border">
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>名称</TableHead>
										<TableHead>型号</TableHead>
										<TableHead>类型</TableHead>
										<TableHead>产品线</TableHead>
										<TableHead>确认状态</TableHead>
										{canManage && <TableHead className="text-right">操作</TableHead>}
									</TableRow>
								</TableHeader>
								<TableBody>
									{brand.products.map((product) => (
										<TableRow key={product.id} className={product.status === "DISABLED" ? "opacity-60" : undefined}>
											<TableCell>
												{product.name}
												{product.status === "DISABLED" && (
													<span className="ml-2 text-xs text-muted-foreground">已停用</span>
												)}
											</TableCell>
											<TableCell className="font-mono text-xs">{product.model ?? "—"}</TableCell>
											<TableCell>{GEO_TERM_KIND_LABELS[product.termKind]}</TableCell>
											<TableCell>{product.category ?? "—"}</TableCell>
											<TableCell>
												<GeoFactStatusBadge status={product.factStatus} />
											</TableCell>
											{canManage && (
												<TableCell className="text-right">
													<Button variant="ghost" size="sm" onClick={() => onEditProduct(product)}>
														编辑
													</Button>
													<Button variant="ghost" size="sm" onClick={() => onToggleProduct(product)}>
														{product.status === "DISABLED" ? "启用" : "停用"}
													</Button>
												</TableCell>
											)}
										</TableRow>
									))}
								</TableBody>
							</Table>
						</div>
					)}
				</div>
			</CardContent>
		</Card>
	);
}
