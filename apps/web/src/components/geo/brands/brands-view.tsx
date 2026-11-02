import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { GeoBrandKind } from "@workspace/geo-domain";
import { Alert, AlertDescription } from "@workspace/ui/components/alert";
import { Button } from "@workspace/ui/components/button";
import { Skeleton } from "@workspace/ui/components/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@workspace/ui/components/tabs";
import { Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { GeoEmptyState } from "@/components/geo/shell/empty-state";
import { GeoPageFrame } from "@/components/geo/shell/page-frame";
import { useGeoViewer } from "@/components/geo/shell/use-geo-viewer";
import {
	createGeoBrandFn,
	createGeoProductFn,
	listGeoBrandsFn,
	setGeoBrandStatusFn,
	updateGeoBrandFn,
	updateGeoProductFn,
} from "@/server/geo/profile";
import type { GeoBrandEntity, GeoBrandWithProducts, GeoProduct } from "@/server/geo/profile-core";
import { listGeoMembersFn } from "@/server/geo/prompts";
import { BrandCard } from "./brand-card";
import { BrandFormDialog, type BrandFormValues, brandPayload } from "./brand-form-dialog";
import { BrandHistoryDialog } from "./brand-history-dialog";
import { DictionaryVersionsPanel } from "./dictionary-versions-panel";
import { geoErrorMessage } from "./format";
import { ProductFormDialog, type ProductFormValues, productPayload } from "./product-form-dialog";

type BrandDialog = { kind: GeoBrandKind; brand: GeoBrandEntity | null } | null;
type ProductDialog = { brand: GeoBrandWithProducts; product: GeoProduct | null } | null;

export function GeoBrandsView({ organizationId }: { organizationId: string }) {
	const viewer = useGeoViewer();
	const canManage = viewer.can("brand.manage");
	const queryClient = useQueryClient();
	const [tab, setTab] = useState<string>("OWN");
	const [brandDialog, setBrandDialog] = useState<BrandDialog>(null);
	const [productDialog, setProductDialog] = useState<ProductDialog>(null);
	const [historyFor, setHistoryFor] = useState<string | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);

	const brandsQuery = useQuery({
		queryKey: ["geo-brands", organizationId],
		queryFn: () => listGeoBrandsFn({ data: { organizationId } }),
	});
	const membersQuery = useQuery({
		queryKey: ["geo-members", organizationId],
		queryFn: () => listGeoMembersFn({ data: { organizationId } }),
		staleTime: 5 * 60_000,
	});
	const members = useMemo(
		() => new Map((membersQuery.data ?? []).map((member) => [member.userId, member.name || member.email])),
		[membersQuery.data],
	);

	const refresh = () =>
		Promise.all([
			queryClient.invalidateQueries({ queryKey: ["geo-brands", organizationId] }),
			queryClient.invalidateQueries({ queryKey: ["geo-dictionary-versions", organizationId] }),
			queryClient.invalidateQueries({ queryKey: ["geo-brand", organizationId] }),
		]);

	const saveBrand = useMutation({
		mutationFn: ({ dialog, values }: { dialog: NonNullable<BrandDialog>; values: BrandFormValues }) =>
			dialog.brand
				? updateGeoBrandFn({ data: { organizationId, brandId: dialog.brand.id, patch: brandPayload(values) } })
				: createGeoBrandFn({ data: { organizationId, brand: { kind: dialog.kind, ...brandPayload(values) } } }),
		onSuccess: async () => {
			setBrandDialog(null);
			await refresh();
		},
	});
	const saveProduct = useMutation({
		mutationFn: ({ dialog, values }: { dialog: NonNullable<ProductDialog>; values: ProductFormValues }) =>
			dialog.product
				? updateGeoProductFn({
						data: {
							organizationId,
							brandId: dialog.brand.id,
							productId: dialog.product.id,
							patch: productPayload(values),
						},
					})
				: createGeoProductFn({ data: { organizationId, brandId: dialog.brand.id, product: productPayload(values) } }),
		onSuccess: async () => {
			setProductDialog(null);
			await refresh();
		},
	});
	const toggle = useMutation({
		mutationFn: (action: () => Promise<unknown>) => action(),
		onMutate: () => setActionError(null),
		onSuccess: refresh,
		onError: (error) => setActionError(geoErrorMessage(error)),
	});

	const brands = brandsQuery.data ?? [];
	const byKind = (kind: GeoBrandKind) => brands.filter((brand) => brand.kind === kind);

	const renderList = (kind: GeoBrandKind) => {
		const list = byKind(kind);
		if (list.length === 0) {
			return (
				<GeoEmptyState
					title={kind === "OWN" ? "尚未配置自有品牌" : "尚未配置竞品"}
					description={
						kind === "OWN"
							? "录入品牌法定名、简称、别名和域名后，评估会据此识别 AI 回答中的品牌提及。"
							: "竞品名单需由客户市场或销售确认；未确认前请保持“待客户确认”。"
					}
					action={
						canManage && (
							<Button size="sm" onClick={() => setBrandDialog({ kind, brand: null })}>
								<Plus className="size-4" />
								{kind === "OWN" ? "新增品牌" : "新增竞品"}
							</Button>
						)
					}
				/>
			);
		}
		return (
			<div className="flex flex-col gap-4">
				{list.map((brand) => (
					<BrandCard
						key={brand.id}
						brand={brand}
						canManage={canManage}
						onEdit={() => {
							saveBrand.reset();
							setBrandDialog({ kind: brand.kind, brand });
						}}
						onHistory={() => setHistoryFor(brand.id)}
						onToggleStatus={() =>
							toggle.mutate(() =>
								setGeoBrandStatusFn({
									data: {
										organizationId,
										brandId: brand.id,
										status: brand.status === "ACTIVE" ? "DISABLED" : "ACTIVE",
									},
								}),
							)
						}
						onAddProduct={() => {
							saveProduct.reset();
							setProductDialog({ brand, product: null });
						}}
						onEditProduct={(product) => {
							saveProduct.reset();
							setProductDialog({ brand, product });
						}}
						onToggleProduct={(product) =>
							toggle.mutate(() =>
								updateGeoProductFn({
									data: {
										organizationId,
										brandId: brand.id,
										productId: product.id,
										patch: { status: product.status === "ACTIVE" ? "DISABLED" : "ACTIVE" },
									},
								}),
							)
						}
					/>
				))}
			</div>
		);
	};

	return (
		<GeoPageFrame
			title="品牌与竞品"
			description="管理品牌、产品、别名、竞品和域名。每次变更生成不可变的词典版本，历史评估不会被改写。"
			actions={
				canManage && (
					<>
						<Button
							variant="outline"
							onClick={() => {
								saveBrand.reset();
								setBrandDialog({ kind: "COMPETITOR", brand: null });
							}}
						>
							<Plus className="size-4" />
							新增竞品
						</Button>
						<Button
							onClick={() => {
								saveBrand.reset();
								setBrandDialog({ kind: "OWN", brand: null });
							}}
						>
							<Plus className="size-4" />
							新增品牌
						</Button>
					</>
				)
			}
		>
			{actionError && (
				<Alert variant="destructive">
					<AlertDescription>{actionError}</AlertDescription>
				</Alert>
			)}
			{brandsQuery.isError && (
				<Alert variant="destructive">
					<AlertDescription>{geoErrorMessage(brandsQuery.error)}</AlertDescription>
				</Alert>
			)}
			<Tabs value={tab} onValueChange={(value) => setTab(String(value ?? "OWN"))}>
				<TabsList>
					<TabsTrigger value="OWN">自有品牌（{byKind("OWN").length}）</TabsTrigger>
					<TabsTrigger value="COMPETITOR">竞品（{byKind("COMPETITOR").length}）</TabsTrigger>
					<TabsTrigger value="versions">词典版本</TabsTrigger>
				</TabsList>
				{brandsQuery.isLoading ? (
					<Skeleton className="h-48 w-full" />
				) : (
					<>
						<TabsContent value="OWN">{renderList("OWN")}</TabsContent>
						<TabsContent value="COMPETITOR">{renderList("COMPETITOR")}</TabsContent>
					</>
				)}
				<TabsContent value="versions">
					<DictionaryVersionsPanel organizationId={organizationId} members={members} />
				</TabsContent>
			</Tabs>

			{brandDialog && (
				<BrandFormDialog
					key={brandDialog.brand?.id ?? `new-${brandDialog.kind}`}
					open
					onOpenChange={(open) => !open && setBrandDialog(null)}
					kind={brandDialog.kind}
					brand={brandDialog.brand}
					pending={saveBrand.isPending}
					error={saveBrand.error ? geoErrorMessage(saveBrand.error) : null}
					onSubmit={(values) => saveBrand.mutate({ dialog: brandDialog, values })}
				/>
			)}
			{productDialog && (
				<ProductFormDialog
					key={productDialog.product?.id ?? `new-${productDialog.brand.id}`}
					open
					onOpenChange={(open) => !open && setProductDialog(null)}
					brandName={productDialog.brand.displayName}
					product={productDialog.product}
					pending={saveProduct.isPending}
					error={saveProduct.error ? geoErrorMessage(saveProduct.error) : null}
					onSubmit={(values) => saveProduct.mutate({ dialog: productDialog, values })}
				/>
			)}
			<BrandHistoryDialog
				organizationId={organizationId}
				brandId={historyFor}
				members={members}
				onOpenChange={(open) => !open && setHistoryFor(null)}
			/>
		</GeoPageFrame>
	);
}
