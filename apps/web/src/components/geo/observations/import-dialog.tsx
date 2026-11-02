import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GEO_PLATFORM_LABELS, GEO_PLATFORMS, type GeoPlatform } from "@workspace/geo-domain";
import { Alert, AlertDescription, AlertTitle } from "@workspace/ui/components/alert";
import { Button, buttonVariants } from "@workspace/ui/components/button";
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@workspace/ui/components/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@workspace/ui/components/tabs";
import { Textarea } from "@workspace/ui/components/textarea";
import { cn } from "@workspace/ui/lib/utils";
import { useMemo, useState } from "react";
import { observationKeys, samplingKeys } from "@/components/geo/sampling/keys";
import { useGeoOrganization } from "@/components/geo/sampling/use-geo-organization";
import { useWriteErrorMessage } from "@/lib/write-errors";
import { importManualObservationsFn } from "@/server/geo/observations";
import type { ManualImportResult } from "@/server/geo/observations-import-core";
import { listFrozenPromptSetsFn } from "@/server/geo/sampling";

const FIELD_LABELS: Record<string, string> = {
	sampledAt: "采样时间",
	platform: "平台",
	question: "问题",
	promptId: "问法 ID",
	responseText: "回答原文",
	evidenceLocation: "证据位置",
	citations: "引用链接",
	targetId: "目标 ID",
	status: "状态",
	rows: "记录",
	content: "文件",
};

const NO_SET = "none";

interface SingleForm {
	sampledAt: string;
	platform: GeoPlatform;
	question: string;
	responseText: string;
	evidenceLocation: string;
	citations: string;
	modelVersion: string;
	note: string;
}

const EMPTY: SingleForm = {
	sampledAt: "",
	platform: "doubao",
	question: "",
	responseText: "",
	evidenceLocation: "",
	citations: "",
	modelVersion: "",
	note: "",
};

type ImportRequest =
	| { format: "rows"; rows: unknown[]; promptSetId?: string }
	| { format: "csv" | "json"; content: string; promptSetId?: string };

async function uploadEvidence(orgSlug: string, file: File): Promise<string> {
	const body = new FormData();
	body.append("file", file);
	const response = await fetch(`/api/geo/${encodeURIComponent(orgSlug)}/evidence`, { method: "POST", body });
	const payload = (await response.json().catch(() => null)) as {
		data?: { ref: string };
		error?: { message?: string };
	} | null;
	if (!response.ok || !payload?.data) throw new Error(payload?.error?.message ?? "上传失败");
	return payload.data.ref;
}

function ImportOutcome({ result }: { result: ManualImportResult }) {
	if (result.ok) {
		return (
			<Alert>
				<AlertTitle>已导入 {result.created} 条证据</AlertTitle>
				<AlertDescription>
					{result.skipped > 0
						? `另有 ${result.skipped} 条与已有证据完全相同（第 ${result.skippedRows.join("、")} 行），已跳过。`
						: "导入的证据会进入评估流程。"}
				</AlertDescription>
			</Alert>
		);
	}
	return (
		<div className="flex flex-col gap-2">
			<Alert variant="destructive">
				<AlertTitle>{result.code === "EVIDENCE_REQUIRED" ? "缺少必需的证据字段" : "存在格式错误"}</AlertTitle>
				<AlertDescription>{result.message}。整批未导入，请修正后重新提交。</AlertDescription>
			</Alert>
			<div className="max-h-56 overflow-y-auto rounded-md border">
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead className="w-16">行</TableHead>
							<TableHead className="w-24">字段</TableHead>
							<TableHead>问题</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{result.errors.map((error) => (
							<TableRow key={`${error.row}-${error.field}-${error.message}`}>
								<TableCell className="tabular-nums">{error.row || "—"}</TableCell>
								<TableCell>{FIELD_LABELS[error.field] ?? error.field}</TableCell>
								<TableCell>{error.message}</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			</div>
		</div>
	);
}

function SingleEntry({ form, onChange }: { form: SingleForm; onChange: (form: SingleForm) => void }) {
	const organization = useGeoOrganization();
	const [uploading, setUploading] = useState(false);
	const [uploadError, setUploadError] = useState<string | null>(null);
	const set = <K extends keyof SingleForm>(key: K, value: SingleForm[K]) => onChange({ ...form, [key]: value });

	return (
		<div className="grid gap-3">
			<div className="grid grid-cols-2 gap-3">
				<div className="flex flex-col gap-1.5">
					<Label htmlFor="manual-time">采样时间（北京时间）</Label>
					<Input
						id="manual-time"
						type="datetime-local"
						value={form.sampledAt}
						onChange={(e) => set("sampledAt", e.target.value)}
					/>
				</div>
				<div className="flex flex-col gap-1.5">
					<Label htmlFor="manual-platform">平台</Label>
					<Select
						items={GEO_PLATFORM_LABELS}
						value={form.platform}
						onValueChange={(value) => set("platform", value as GeoPlatform)}
					>
						<SelectTrigger id="manual-platform">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{GEO_PLATFORMS.map((platform) => (
								<SelectItem key={platform} value={platform}>
									{GEO_PLATFORM_LABELS[platform]}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
			</div>
			<div className="flex flex-col gap-1.5">
				<Label htmlFor="manual-question">问题（须与问法库中的问题一致）</Label>
				<Textarea id="manual-question" value={form.question} onChange={(e) => set("question", e.target.value)} />
			</div>
			<div className="flex flex-col gap-1.5">
				<Label htmlFor="manual-answer">回答原文</Label>
				<Textarea
					id="manual-answer"
					className="min-h-32"
					value={form.responseText}
					onChange={(e) => set("responseText", e.target.value)}
				/>
			</div>
			<div className="flex flex-col gap-1.5">
				<Label htmlFor="manual-evidence">证据位置</Label>
				<div className="flex gap-2">
					<Input
						id="manual-evidence"
						placeholder="截图链接、存档位置，或上传截图"
						value={form.evidenceLocation}
						onChange={(e) => set("evidenceLocation", e.target.value)}
					/>
					<label
						htmlFor="manual-evidence-file"
						aria-disabled={uploading}
						className={cn(
							buttonVariants({ variant: "outline" }),
							"cursor-pointer",
							uploading && "pointer-events-none opacity-50",
						)}
					>
						{uploading ? "上传中…" : "上传截图"}
					</label>
					<input
						id="manual-evidence-file"
						type="file"
						accept="image/png,image/jpeg,image/webp,application/pdf"
						className="sr-only"
						onChange={async (event) => {
							const file = event.target.files?.[0];
							event.target.value = "";
							if (!file) return;
							setUploadError(null);
							setUploading(true);
							try {
								set("evidenceLocation", await uploadEvidence(organization.slug, file));
							} catch (err) {
								setUploadError(err instanceof Error ? err.message : "上传失败");
							} finally {
								setUploading(false);
							}
						}}
					/>
				</div>
				<p className="text-xs text-muted-foreground">支持 PNG、JPEG、WebP 截图或 PDF，单个不超过 10 MB。</p>
				{uploadError && <p className="text-xs text-destructive">{uploadError}</p>}
			</div>
			<div className="flex flex-col gap-1.5">
				<Label htmlFor="manual-citations">引用链接（每行一个，可选）</Label>
				<Textarea id="manual-citations" value={form.citations} onChange={(e) => set("citations", e.target.value)} />
			</div>
			<div className="grid grid-cols-2 gap-3">
				<div className="flex flex-col gap-1.5">
					<Label htmlFor="manual-model">模型或应用版本（可选）</Label>
					<Input id="manual-model" value={form.modelVersion} onChange={(e) => set("modelVersion", e.target.value)} />
				</div>
				<div className="flex flex-col gap-1.5">
					<Label htmlFor="manual-note">备注（可选）</Label>
					<Input id="manual-note" value={form.note} onChange={(e) => set("note", e.target.value)} />
				</div>
			</div>
		</div>
	);
}

/**
 * Manual evidence, one record or a CSV/JSON file. Time, platform, question, answer text
 * and evidence location are required; a file with any bad row imports nothing.
 */
export function ImportEvidenceDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
	const organization = useGeoOrganization();
	const queryClient = useQueryClient();
	const writeError = useWriteErrorMessage();
	const [tab, setTab] = useState<"single" | "batch">("single");
	const [promptSetId, setPromptSetId] = useState<string>(NO_SET);
	const [form, setForm] = useState<SingleForm>(EMPTY);
	const [file, setFile] = useState<File | null>(null);
	const [result, setResult] = useState<ManualImportResult | null>(null);
	const [error, setError] = useState<string | null>(null);

	const sets = useQuery({
		queryKey: samplingKeys.promptSets(organization.id),
		queryFn: () => listFrozenPromptSetsFn({ data: { organizationId: organization.id } }),
		enabled: open,
	});
	const setItems = useMemo(
		() => ({
			[NO_SET]: "不指定（按问法库匹配）",
			...Object.fromEntries((sets.data ?? []).map((item) => [item.id, `${item.name} · v${item.version}`])),
		}),
		[sets.data],
	);

	const submit = useMutation({
		mutationFn: async (): Promise<ManualImportResult> => {
			const scope = promptSetId === NO_SET ? {} : { promptSetId };
			let input: ImportRequest;
			if (tab === "single") {
				input = {
					format: "rows",
					...scope,
					rows: [
						{
							...form,
							sampledAt: form.sampledAt.replace("T", " "),
							citations: form.citations.split(/\s+/).filter(Boolean),
						},
					],
				};
			} else {
				if (!file) throw new Error("请选择 CSV 或 JSON 文件");
				const format = file.name.toLowerCase().endsWith(".json") ? "json" : "csv";
				input = { format, content: await file.text(), ...scope };
			}
			return importManualObservationsFn({ data: { organizationId: organization.id, input } });
		},
		onSuccess: async (data) => {
			setResult(data);
			if (data.ok) {
				setForm(EMPTY);
				setFile(null);
				await queryClient.invalidateQueries({ queryKey: observationKeys.all(organization.id) });
			}
		},
		onError: (err) => setError(writeError(err, "导入失败")),
	});

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>导入人工证据</DialogTitle>
					<DialogDescription>
						每条证据都必须带采样时间、平台、问题、回答原文和证据位置。证据写入后不可修改，更正只会生成新的评估版本。
					</DialogDescription>
				</DialogHeader>
				<div className="flex flex-col gap-1.5">
					<Label htmlFor="import-set">归入问法集</Label>
					<Select items={setItems} value={promptSetId} onValueChange={(value) => setPromptSetId(value as string)}>
						<SelectTrigger id="import-set">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{Object.entries(setItems).map(([value, label]) => (
								<SelectItem key={value} value={value}>
									{label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<p className="text-xs text-muted-foreground">
						指定问法集后，证据可与同一问法集的自动采样结果按相同口径比较。
					</p>
				</div>
				<Tabs value={tab} onValueChange={(value) => setTab(value as "single" | "batch")}>
					<TabsList>
						<TabsTrigger value="single">单条录入</TabsTrigger>
						<TabsTrigger value="batch">批量导入</TabsTrigger>
					</TabsList>
					<TabsContent value="single" className="pt-3">
						<SingleEntry form={form} onChange={setForm} />
					</TabsContent>
					<TabsContent value="batch" className="flex flex-col gap-2 pt-3">
						<Label htmlFor="import-file">CSV 或 JSON 文件</Label>
						<Input
							id="import-file"
							type="file"
							accept=".csv,.json,text/csv,application/json"
							onChange={(e) => setFile(e.target.files?.[0] ?? null)}
						/>
						<p className="text-xs text-muted-foreground">
							CSV 表头：采样时间、平台、问题、回答原文、证据位置，可选引用链接、模型版本、状态、备注（也可用
							sampled_at、platform、question、response_text、evidence_location）。JSON 为同字段的记录数组。单次最多 1000
							条。
						</p>
					</TabsContent>
				</Tabs>
				{result && <ImportOutcome result={result} />}
				{error && (
					<Alert variant="destructive">
						<AlertDescription>{error}</AlertDescription>
					</Alert>
				)}
				<DialogFooter>
					<Button variant="outline" onClick={() => onOpenChange(false)}>
						关闭
					</Button>
					<Button
						disabled={submit.isPending}
						onClick={() => {
							setError(null);
							setResult(null);
							submit.mutate();
						}}
					>
						{submit.isPending ? "导入中…" : "导入"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
