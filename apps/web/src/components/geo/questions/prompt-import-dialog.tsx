import { GEO_PROMPT_CSV_COLUMNS, GEO_PROMPT_CSV_MAX_ROWS } from "@workspace/geo-domain";
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
import { Spinner } from "@workspace/ui/components/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@workspace/ui/components/table";
import { useState } from "react";
import type { GeoPromptImportResult } from "@/server/geo/prompts-core";

const MAX_BYTES = 1024 * 1024;

export function PromptImportDialog({
	pending,
	error,
	result,
	onOpenChange,
	onImport,
}: {
	pending: boolean;
	error: string | null;
	result: GeoPromptImportResult | null;
	onOpenChange: (open: boolean) => void;
	onImport: (csv: string) => void;
}) {
	const [file, setFile] = useState<File | null>(null);
	const [localError, setLocalError] = useState<string | null>(null);

	const submit = async () => {
		if (!file) return;
		if (file.size > MAX_BYTES) {
			setLocalError("CSV 文件不能超过 1 MB");
			return;
		}
		setLocalError(null);
		onImport(await file.text());
	};

	const succeeded = result && result.errors.length === 0;
	return (
		<Dialog open onOpenChange={onOpenChange}>
			<DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>导入问法 CSV</DialogTitle>
					<DialogDescription>
						UTF-8 编码，首行为列名，必须包含 question 列；可用列：{GEO_PROMPT_CSV_COLUMNS.join("、")}。 填写 prompt_id
						会修改对应的草稿问法；status 与 test_set_version
						列只用于导出，导入时忽略。整份文件校验通过才会写入，单次最多 {GEO_PROMPT_CSV_MAX_ROWS} 行。
					</DialogDescription>
				</DialogHeader>
				<div className="flex flex-col gap-1.5">
					<Label htmlFor="prompt-csv-file">CSV 文件</Label>
					<Input
						id="prompt-csv-file"
						type="file"
						accept=".csv,text/csv"
						onChange={(event) => setFile(event.target.files?.[0] ?? null)}
					/>
				</div>
				{(localError || error) && (
					<p className="text-sm text-destructive" role="alert">
						{localError ?? error}
					</p>
				)}
				{succeeded && (
					<p className="text-sm text-emerald-700">
						导入完成：新增 {result.created} 条，修改 {result.updated} 条，未变化 {result.unchanged}{" "}
						条。新问法均为草稿，需提交业务审核。
					</p>
				)}
				{result && result.errors.length > 0 && (
					<div className="flex flex-col gap-2">
						<p className="text-sm text-destructive">
							发现 {result.errors.length} 处错误，整份文件未导入。修正后重新上传：
						</p>
						<div className="max-h-64 overflow-y-auto rounded-lg border">
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead className="w-16">行</TableHead>
										<TableHead className="w-32">列</TableHead>
										<TableHead>问题</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{result.errors.map((entry) => (
										<TableRow key={`${entry.line}-${entry.column}-${entry.message}`}>
											<TableCell className="tabular-nums">{entry.line}</TableCell>
											<TableCell className="font-mono text-xs">{entry.column ?? "—"}</TableCell>
											<TableCell className="whitespace-normal">{entry.message}</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>
						</div>
					</div>
				)}
				<DialogFooter>
					<Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
						{succeeded ? "关闭" : "取消"}
					</Button>
					{!succeeded && (
						<Button onClick={submit} disabled={pending || !file}>
							{pending && <Spinner />}
							导入
						</Button>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
