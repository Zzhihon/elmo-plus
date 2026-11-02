import {
	GEO_FACT_STATUS_LABELS,
	GEO_FACT_STATUSES,
	GEO_TERM_KIND_LABELS,
	GEO_TERM_KINDS,
	type GeoFactStatus,
	type GeoTermKind,
	productTermProblem,
} from "@workspace/geo-domain";
import { Button } from "@workspace/ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@workspace/ui/components/dialog";
import { Input } from "@workspace/ui/components/input";
import { Label } from "@workspace/ui/components/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@workspace/ui/components/select";
import { Spinner } from "@workspace/ui/components/spinner";
import { type FormEvent, useState } from "react";
import type { GeoProduct } from "@/server/geo/profile-core";

export interface ProductFormValues {
	name: string;
	model: string;
	category: string;
	termKind: GeoTermKind;
	factStatus: GeoFactStatus;
}

export function ProductFormDialog({
	open,
	onOpenChange,
	brandName,
	product,
	pending,
	error,
	onSubmit,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	brandName: string;
	product: GeoProduct | null;
	pending: boolean;
	error: string | null;
	onSubmit: (values: ProductFormValues) => void;
}) {
	const [values, setValues] = useState<ProductFormValues>({
		name: product?.name ?? "",
		model: product?.model ?? "",
		category: product?.category ?? "",
		termKind: product?.termKind ?? "GENERIC",
		factStatus: product?.factStatus ?? "UNVERIFIED",
	});
	const set = <K extends keyof ProductFormValues>(key: K, value: ProductFormValues[K]) =>
		setValues((current) => ({ ...current, [key]: value }));
	const problem = productTermProblem({ termKind: values.termKind, model: values.model });

	const submit = (event: FormEvent) => {
		event.preventDefault();
		if (!problem) onSubmit(values);
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<form onSubmit={submit} className="flex flex-col gap-4">
					<DialogHeader>
						<DialogTitle>{product ? "编辑产品" : "新增产品"}</DialogTitle>
						<DialogDescription>
							{brandName}。通用产品词用于识别品类（如“高低压开关柜”）；客户型号是该品牌专有的型号标识。
						</DialogDescription>
					</DialogHeader>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="product-term-kind">类型</Label>
						<Select
							items={GEO_TERM_KIND_LABELS}
							value={values.termKind}
							onValueChange={(value) => value && set("termKind", value as GeoTermKind)}
						>
							<SelectTrigger id="product-term-kind">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{GEO_TERM_KINDS.map((kind) => (
									<SelectItem key={kind} value={kind}>
										{GEO_TERM_KIND_LABELS[kind]}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
					<div className="grid gap-4 sm:grid-cols-2">
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="product-name">名称</Label>
							<Input
								id="product-name"
								required
								maxLength={200}
								value={values.name}
								onChange={(event) => set("name", event.target.value)}
							/>
						</div>
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="product-model">型号</Label>
							<Input
								id="product-model"
								maxLength={100}
								disabled={values.termKind === "GENERIC"}
								value={values.termKind === "GENERIC" ? "" : values.model}
								onChange={(event) => set("model", event.target.value)}
							/>
						</div>
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="product-category">产品线</Label>
							<Input
								id="product-category"
								maxLength={100}
								value={values.category}
								onChange={(event) => set("category", event.target.value)}
							/>
						</div>
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="product-fact-status">客户确认状态</Label>
							<Select
								items={GEO_FACT_STATUS_LABELS}
								value={values.factStatus}
								onValueChange={(value) => value && set("factStatus", value as GeoFactStatus)}
							>
								<SelectTrigger id="product-fact-status">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{GEO_FACT_STATUSES.map((status) => (
										<SelectItem key={status} value={status}>
											{GEO_FACT_STATUS_LABELS[status]}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
					</div>
					{(error || (problem && values.termKind === "CUSTOMER_MODEL" && values.name)) && (
						<p className="text-sm text-destructive" role="alert">
							{error ?? problem}
						</p>
					)}
					<DialogFooter>
						<Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
							取消
						</Button>
						<Button type="submit" disabled={pending || !values.name.trim() || Boolean(problem)}>
							{pending && <Spinner />}
							保存
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

export function productPayload(values: ProductFormValues) {
	return {
		name: values.name,
		model: values.termKind === "GENERIC" ? null : values.model || null,
		category: values.category || null,
		termKind: values.termKind,
		factStatus: values.factStatus,
	};
}
