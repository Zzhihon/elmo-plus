import { useQuery } from "@tanstack/react-query";
import { GEO_PROMPT_TIER_LABELS } from "@workspace/geo-domain";
import { Button } from "@workspace/ui/components/button";
import { Checkbox } from "@workspace/ui/components/checkbox";
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
import { Skeleton } from "@workspace/ui/components/skeleton";
import { Spinner } from "@workspace/ui/components/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@workspace/ui/components/table";
import { useMemo, useState } from "react";
import { formatGeoDateTime, geoActorLabel } from "@/components/geo/brands/format";
import { GeoPromptStatusBadge, GeoStatusBadge } from "@/components/geo/shell/status-badge";
import { getGeoPromptSetFn } from "@/server/geo/prompts";
import type { GeoBuyerRole, GeoPromptOption } from "@/server/geo/prompts-core";

const FREEZABLE = new Set(["BASELINE", "FROZEN"]);

export function PromptSetEditorDialog({
	title,
	initialName,
	nameLocked,
	initialSelection,
	options,
	roles,
	pending,
	error,
	onOpenChange,
	onSubmit,
}: {
	title: string;
	initialName: string;
	nameLocked: boolean;
	initialSelection: string[];
	options: GeoPromptOption[];
	roles: GeoBuyerRole[];
	pending: boolean;
	error: string | null;
	onOpenChange: (open: boolean) => void;
	onSubmit: (value: { name: string; promptIds: string[] }) => void;
}) {
	const [name, setName] = useState(initialName);
	const [selected, setSelected] = useState<string[]>(initialSelection);
	const [search, setSearch] = useState("");
	const [onlyReviewed, setOnlyReviewed] = useState(true);
	const roleTitles = useMemo(() => new Map(roles.map((role) => [role.id, role.title])), [roles]);
	const chosen = new Set(selected);

	const visible = options.filter(
		(option) =>
			(!onlyReviewed || FREEZABLE.has(option.status) || chosen.has(option.id)) &&
			(!search.trim() || option.question.includes(search.trim())),
	);
	const selectedOptions = options.filter((option) => chosen.has(option.id));
	const blocked = selectedOptions.filter((option) => !FREEZABLE.has(option.status)).length;
	const core = selectedOptions.filter((option) => option.tier === "CORE").length;

	const toggle = (id: string, checked: boolean) =>
		setSelected((current) => (checked ? [...current, id] : current.filter((value) => value !== id)));

	return (
		<Dialog open onOpenChange={onOpenChange}>
			<DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
					<DialogDescription>
						测试集冻结后不可修改，后续变化必须生成新版本。只有通过业务审核（入选基线）或已冻结的问法可以被冻结；扩展问法会保存在集合中，但默认不进入高频监测。
					</DialogDescription>
				</DialogHeader>
				<div className="flex flex-col gap-1.5">
					<Label htmlFor="prompt-set-name">测试集名称</Label>
					<Input
						id="prompt-set-name"
						maxLength={100}
						disabled={nameLocked}
						value={name}
						onChange={(event) => setName(event.target.value)}
						placeholder="例如：核心问法基线"
					/>
				</div>
				<div className="flex flex-wrap items-center gap-3">
					<Input
						className="max-w-xs"
						placeholder="搜索问法"
						value={search}
						onChange={(event) => setSearch(event.target.value)}
					/>
					<Label className="flex items-center gap-2 text-sm font-normal">
						<Checkbox checked={onlyReviewed} onCheckedChange={(checked) => setOnlyReviewed(Boolean(checked))} />
						只显示已通过审核的问法
					</Label>
					<span className="text-sm text-muted-foreground">
						已选 {selected.length} 条（核心 {core} 条）
					</span>
				</div>
				<div className="max-h-80 overflow-y-auto rounded-lg border">
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead className="w-10" />
								<TableHead>问法</TableHead>
								<TableHead>角色</TableHead>
								<TableHead>层级</TableHead>
								<TableHead>状态</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{visible.map((option) => (
								<TableRow key={option.id}>
									<TableCell>
										<Checkbox
											aria-label="选择问法"
											checked={chosen.has(option.id)}
											onCheckedChange={(checked) => toggle(option.id, Boolean(checked))}
										/>
									</TableCell>
									<TableCell className="max-w-md whitespace-normal">{option.question}</TableCell>
									<TableCell>{(option.buyerRoleId && roleTitles.get(option.buyerRoleId)) || "—"}</TableCell>
									<TableCell>{GEO_PROMPT_TIER_LABELS[option.tier]}</TableCell>
									<TableCell>
										<GeoPromptStatusBadge status={option.status} />
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</div>
				{blocked > 0 && (
					<p className="text-sm text-amber-700">已选中 {blocked} 条未通过审核的问法，冻结前需要先完成业务审核。</p>
				)}
				{error && (
					<p className="text-sm text-destructive" role="alert">
						{error}
					</p>
				)}
				<DialogFooter>
					<Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
						取消
					</Button>
					<Button
						disabled={pending || !name.trim()}
						onClick={() => onSubmit({ name: name.trim(), promptIds: selected })}
					>
						{pending && <Spinner />}
						保存草稿
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

export function PromptSetDetailDialog({
	organizationId,
	setId,
	members,
	onOpenChange,
}: {
	organizationId: string;
	setId: string;
	members: ReadonlyMap<string, string>;
	onOpenChange: (open: boolean) => void;
}) {
	const { data, isLoading } = useQuery({
		queryKey: ["geo-prompt-set", organizationId, setId],
		queryFn: () => getGeoPromptSetFn({ data: { organizationId, setId } }),
	});
	return (
		<Dialog open onOpenChange={onOpenChange}>
			<DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
				<DialogHeader>
					<DialogTitle>{data ? `${data.name} v${data.version}` : "测试集"}</DialogTitle>
					<DialogDescription>
						{data?.status === "FROZEN"
							? `冻结于 ${formatGeoDateTime(data.frozenAt)}，操作人 ${geoActorLabel(data.frozenBy ?? "", members)}。以下为冻结时的问法快照，监测轮次只使用这些文本。`
							: "草稿测试集，条目随问法当前内容变化，冻结时固定。"}
					</DialogDescription>
				</DialogHeader>
				{isLoading && <Skeleton className="h-32 w-full" />}
				{data && (
					<div className="rounded-lg border">
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>问法快照</TableHead>
									<TableHead>角色</TableHead>
									<TableHead>层级</TableHead>
									<TableHead>修订</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{data.items.map((item) => (
									<TableRow key={item.promptId}>
										<TableCell className="max-w-md whitespace-normal">{item.questionText}</TableCell>
										<TableCell>{item.labels.buyerRoleTitle ?? "—"}</TableCell>
										<TableCell>{GEO_PROMPT_TIER_LABELS[item.labels.tier]}</TableCell>
										<TableCell className="whitespace-nowrap">
											r{item.promptRevision}
											{data.status === "FROZEN" && item.currentRevision !== item.promptRevision && (
												<GeoStatusBadge className="ml-2" label={`问法已更新至 r${item.currentRevision}`} tone="info" />
											)}
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
}
