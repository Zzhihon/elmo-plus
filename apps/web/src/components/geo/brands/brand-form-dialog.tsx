import { GEO_BRAND_KIND_LABELS, GEO_FACT_STATUS_LABELS, GEO_FACT_STATUSES, type GeoBrandKind } from "@workspace/geo-domain";
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
import { TagsInput } from "@workspace/ui/components/tags-input";
import { Textarea } from "@workspace/ui/components/textarea";
import { type FormEvent, useState } from "react";
import type { GeoBrandEntity } from "@/server/geo/profile-core";

export interface BrandFormValues {
	displayName: string;
	legalName: string;
	shortName: string;
	aliases: string[];
	historicalNames: string[];
	domains: string[];
	officialUrl: string;
	regions: string[];
	factStatus: GeoBrandEntity["factStatus"];
	factNotes: string;
	changeNote: string;
}

const TERM_SPLITTER = /[\n,，、;；]+/;
const DOMAIN_SPLITTER = /[\s,，;；]+/;

function initialValues(brand: GeoBrandEntity | null): BrandFormValues {
	return {
		displayName: brand?.displayName ?? "",
		legalName: brand?.legalName ?? "",
		shortName: brand?.shortName ?? "",
		aliases: brand?.aliases ?? [],
		historicalNames: brand?.historicalNames ?? [],
		domains: brand?.domains ?? [],
		officialUrl: brand?.officialUrl ?? "",
		regions: brand?.regions ?? [],
		factStatus: brand?.factStatus ?? "UNVERIFIED",
		factNotes: (brand?.factNotes ?? []).join("\n"),
		changeNote: "",
	};
}

function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: React.ReactNode }) {
	return (
		<div className="flex flex-col gap-1.5">
			<Label htmlFor={id}>{label}</Label>
			{children}
			{hint && <p className="text-xs text-muted-foreground">{hint}</p>}
		</div>
	);
}

export function BrandFormDialog({
	open,
	onOpenChange,
	kind,
	brand,
	pending,
	error,
	onSubmit,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	kind: GeoBrandKind;
	brand: GeoBrandEntity | null;
	pending: boolean;
	error: string | null;
	onSubmit: (values: BrandFormValues) => void;
}) {
	const [values, setValues] = useState<BrandFormValues>(() => initialValues(brand));
	const set = <K extends keyof BrandFormValues>(key: K, value: BrandFormValues[K]) =>
		setValues((current) => ({ ...current, [key]: value }));

	const submit = (event: FormEvent) => {
		event.preventDefault();
		onSubmit(values);
	};

	const noun = GEO_BRAND_KIND_LABELS[kind];
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
				<form onSubmit={submit} className="flex flex-col gap-4">
					<DialogHeader>
						<DialogTitle>{brand ? `编辑${noun}` : `新增${noun}`}</DialogTitle>
						<DialogDescription>
							保存后生成新的词典版本。已有的采样和评估保留它们使用的版本，不会被改写。
						</DialogDescription>
					</DialogHeader>

					<div className="grid gap-4 sm:grid-cols-2">
						<Field id="brand-display-name" label="显示名称">
							<Input
								id="brand-display-name"
								required
								maxLength={200}
								value={values.displayName}
								onChange={(event) => set("displayName", event.target.value)}
							/>
						</Field>
						<Field id="brand-short-name" label="简称">
							<Input
								id="brand-short-name"
								maxLength={100}
								value={values.shortName}
								onChange={(event) => set("shortName", event.target.value)}
							/>
						</Field>
						<Field id="brand-legal-name" label="法定名称">
							<Input
								id="brand-legal-name"
								maxLength={200}
								value={values.legalName}
								onChange={(event) => set("legalName", event.target.value)}
							/>
						</Field>
						<Field id="brand-official-url" label="官网">
							<Input
								id="brand-official-url"
								type="url"
								placeholder="https://www.example-electric.test/"
								value={values.officialUrl}
								onChange={(event) => set("officialUrl", event.target.value)}
							/>
						</Field>
					</div>

					<Field id="brand-aliases" label="别名" hint="大小写、全半角和空格不同的写法会合并为一个；与其他品牌或竞品重复会被拒绝。">
						<TagsInput
							value={values.aliases}
							onValueChange={(next) => set("aliases", next)}
							placeholder="添加别名"
							searchPlaceholder="输入别名后回车"
							emptyText="输入后回车添加"
							pasteSplitter={TERM_SPLITTER}
							maxItems={100}
						/>
					</Field>
					<Field id="brand-historical-names" label="历史名称">
						<TagsInput
							value={values.historicalNames}
							onValueChange={(next) => set("historicalNames", next)}
							placeholder="添加历史名称"
							searchPlaceholder="输入后回车"
							emptyText="输入后回车添加"
							pasteSplitter={TERM_SPLITTER}
							maxItems={50}
						/>
					</Field>
					<Field id="brand-domains" label="品牌域名" hint="只填主机名，例如 www.example-electric.test；www 与裸域视为同一站点。">
						<TagsInput
							value={values.domains}
							onValueChange={(next) => set("domains", next)}
							placeholder="添加域名"
							searchPlaceholder="输入域名后回车"
							emptyText="输入后回车添加"
							pasteSplitter={DOMAIN_SPLITTER}
							normalizeValue={(raw) => raw.trim().toLowerCase()}
							maxItems={20}
						/>
					</Field>
					<Field id="brand-regions" label="服务区域">
						<TagsInput
							value={values.regions}
							onValueChange={(next) => set("regions", next)}
							placeholder="添加区域"
							searchPlaceholder="输入后回车"
							emptyText="输入后回车添加"
							pasteSplitter={TERM_SPLITTER}
							maxItems={50}
						/>
					</Field>

					<div className="grid gap-4 sm:grid-cols-[12rem_1fr]">
						<Field id="brand-fact-status" label="客户确认状态">
							<Select
								items={GEO_FACT_STATUS_LABELS}
								value={values.factStatus}
								onValueChange={(value) => value && set("factStatus", value as BrandFormValues["factStatus"])}
							>
								<SelectTrigger id="brand-fact-status">
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
						</Field>
						<Field id="brand-fact-notes" label="待核实事实" hint="每行一条。外部资料中的数字和资质只记在这里，经客户原件核实后再改状态。">
							<Textarea
								id="brand-fact-notes"
								rows={3}
								value={values.factNotes}
								onChange={(event) => set("factNotes", event.target.value)}
							/>
						</Field>
					</div>

					{brand && (
						<Field id="brand-change-note" label="变更说明">
							<Input
								id="brand-change-note"
								maxLength={500}
								placeholder="例如：客户确认新增简称"
								value={values.changeNote}
								onChange={(event) => set("changeNote", event.target.value)}
							/>
						</Field>
					)}

					{error && (
						<p className="text-sm text-destructive" role="alert">
							{error}
						</p>
					)}
					<DialogFooter>
						<Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
							取消
						</Button>
						<Button type="submit" disabled={pending || !values.displayName.trim()}>
							{pending && <Spinner />}
							保存
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

export function brandPayload(values: BrandFormValues) {
	return {
		displayName: values.displayName,
		legalName: values.legalName || null,
		shortName: values.shortName || null,
		aliases: values.aliases,
		historicalNames: values.historicalNames,
		domains: values.domains,
		officialUrl: values.officialUrl || null,
		regions: values.regions,
		factStatus: values.factStatus,
		factNotes: values.factNotes
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean),
		changeNote: values.changeNote || null,
	};
}
