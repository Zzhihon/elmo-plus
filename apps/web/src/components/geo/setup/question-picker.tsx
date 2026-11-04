import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, AlertDescription } from "@workspace/ui/components/alert";
import { Badge } from "@workspace/ui/components/badge";
import { Button } from "@workspace/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@workspace/ui/components/card";
import { Checkbox } from "@workspace/ui/components/checkbox";
import { Skeleton } from "@workspace/ui/components/skeleton";
import { cn } from "@workspace/ui/lib/utils";
import { useEffect, useMemo, useState } from "react";
import { geoErrorMessage } from "@/components/geo/brands/format";
import { useGeoViewer } from "@/components/geo/shell/use-geo-viewer";
import { getQuestionCatalogFn, saveCatalogSelectionFn } from "@/server/geo/setup";
import type { GeoCatalogItemView, GeoQuestionCatalogView } from "@/server/geo/setup-core";

function startingSelection(catalog: GeoQuestionCatalogView): Set<string> {
	const pick = (item: GeoCatalogItemView) => (catalog.hasSelection ? item.monitored : item.recommended);
	return new Set(catalog.items.filter((item) => pick(item) && !item.unavailable).map((item) => item.code));
}

function sameSelection(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
	return a.size === b.size && [...a].every((code) => b.has(code));
}

export function QuestionPicker({ organizationId }: { organizationId: string }) {
	const viewer = useGeoViewer();
	const canSelect = viewer.can("prompt.select_catalog");
	const queryClient = useQueryClient();
	const queryKey = ["geo-question-catalog", organizationId];
	const catalogQuery = useQuery({ queryKey, queryFn: () => getQuestionCatalogFn({ data: { organizationId } }) });
	const catalog = catalogQuery.data;

	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [saved, setSaved] = useState(false);
	const initial = useMemo(() => (catalog ? startingSelection(catalog) : new Set<string>()), [catalog]);
	useEffect(() => setSelected(new Set(initial)), [initial]);

	const save = useMutation({
		mutationFn: () => saveCatalogSelectionFn({ data: { organizationId, codes: [...selected] } }),
		onSuccess: async () => {
			setSaved(true);
			await queryClient.invalidateQueries({ queryKey });
		},
	});

	if (catalogQuery.isPending) return <Skeleton className="h-96 w-full" />;
	if (catalogQuery.isError || !catalog) {
		return (
			<Alert variant="destructive">
				<AlertDescription>{geoErrorMessage(catalogQuery.error)}</AlertDescription>
			</Alert>
		);
	}

	const count = selected.size;
	const inRange = count >= catalog.min && count <= catalog.max;
	const dirty = !catalog.hasSelection || !sameSelection(selected, initial);
	const toggle = (code: string, checked: boolean) => {
		setSaved(false);
		setSelected((current) => {
			const next = new Set(current);
			if (checked) next.add(code);
			else next.delete(code);
			return next;
		});
	};
	const resetToRecommended = () => {
		setSaved(false);
		setSelected(
			new Set(catalog.items.filter((item) => item.recommended && !item.unavailable).map((item) => item.code)),
		);
	};

	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/40 p-4">
				<div className="flex flex-col gap-1">
					<p className="text-sm">
						已选 <span className={cn("font-semibold", inRange ? "text-foreground" : "text-destructive")}>{count}</span>{" "}
						个问题，建议 {catalog.min}–{catalog.max} 个
					</p>
					<p className="text-xs text-muted-foreground">
						我们会定期把这些问题发给各个 AI 平台，看回答里有没有提到你们。
						{!catalog.hasSelection && " 已为你预先勾选了推荐问题。"}
					</p>
				</div>
				{canSelect && (
					<div className="flex items-center gap-2">
						<Button variant="outline" onClick={resetToRecommended} disabled={save.isPending}>
							恢复推荐
						</Button>
						<Button onClick={() => save.mutate()} disabled={!inRange || !dirty || save.isPending}>
							{save.isPending ? "保存中…" : "保存选择"}
						</Button>
					</div>
				)}
			</div>

			{!canSelect && (
				<Alert>
					<AlertDescription>你可以查看正在监测的问题；如需调整，请联系管理员或运营人员。</AlertDescription>
				</Alert>
			)}
			{save.isError && (
				<Alert variant="destructive">
					<AlertDescription>{geoErrorMessage(save.error)}</AlertDescription>
				</Alert>
			)}
			{saved && !dirty && (
				<Alert>
					<AlertDescription>已保存。下一轮检查会使用这组问题。</AlertDescription>
				</Alert>
			)}

			<div className="grid gap-4 lg:grid-cols-2">
				{catalog.roles.map((role) => {
					const items = catalog.items.filter((item) => item.buyerRoleCode === role.code);
					const picked = items.filter((item) => selected.has(item.code)).length;
					return (
						<Card key={role.code}>
							<CardHeader>
								<CardTitle className="text-base">{role.title}</CardTitle>
								<CardDescription>已选 {picked} 个</CardDescription>
							</CardHeader>
							<CardContent className="flex flex-col gap-3">
								{items.map((item) => (
									<label
										key={item.code}
										htmlFor={`catalog-${item.code}`}
										className={cn(
											"flex items-start gap-3 text-sm",
											canSelect && !item.unavailable ? "cursor-pointer" : "cursor-default",
										)}
									>
										<Checkbox
											id={`catalog-${item.code}`}
											className="mt-0.5"
											checked={selected.has(item.code)}
											disabled={!canSelect || item.unavailable}
											onCheckedChange={(checked) => toggle(item.code, checked === true)}
										/>
										<span className="flex flex-1 flex-col gap-1">
											<span className={cn(item.unavailable && "text-muted-foreground line-through")}>
												{item.question}
											</span>
											<span className="flex flex-wrap gap-1">
												{item.recommended && <Badge variant="secondary">推荐</Badge>}
												{item.monitored && <Badge variant="outline">监测中</Badge>}
												{item.unavailable && <Badge variant="outline">暂不可用</Badge>}
												<span className="text-xs text-muted-foreground">
													{item.productLine} · {item.intent}
												</span>
											</span>
										</span>
									</label>
								))}
							</CardContent>
						</Card>
					);
				})}
			</div>
		</div>
	);
}
