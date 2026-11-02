import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useRouteContext } from "@tanstack/react-router";
import {
	GEO_KNOWLEDGE_CLAIM_TYPES,
	GEO_SITE_ENTITY_KINDS,
	type GeoKnowledgeClaimType,
	type GeoSiteEntityKind,
} from "@workspace/geo-domain";
import { Alert, AlertDescription, AlertTitle } from "@workspace/ui/components/alert";
import { Button, buttonVariants } from "@workspace/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@workspace/ui/components/card";
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
import { Textarea } from "@workspace/ui/components/textarea";
import { type ReactNode, useState } from "react";
import { GeoEmptyState } from "@/components/geo/shell/empty-state";
import { GeoAssertionStatusBadge } from "@/components/geo/shell/status-badge";
import { useGeoViewer } from "@/components/geo/shell/use-geo-viewer";
import { SimpleSelect } from "@/components/geo/tasks/simple-select";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import {
	registerAssetClaimFn,
	reviewKnowledgeAssetFn,
	searchKnowledgeEntitiesFn,
	updateKnowledgeAssetFn,
} from "@/server/geo/knowledge";
import type { getKnowledgeAsset } from "@/server/geo/knowledge-assets-core";
import { AssetStatusBadges } from "./asset-list";
import { ScopeBadge } from "./citations";
import {
	ASSET_TYPE_LABELS,
	CLAIM_TYPE_FIELD_HINTS,
	CLAIM_TYPE_LABELS,
	claimTypeLabel,
	ENTITY_KIND_LABELS,
	entityKindLabel,
	errorMessage,
	formatBytes,
	formatDate,
	formatDateTime,
} from "./labels";
import { knowledgeKeys } from "./queries";

type AssetDetail = Awaited<ReturnType<typeof getKnowledgeAsset>>;

function Field({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="space-y-1">
			<dt className="text-xs text-muted-foreground">{label}</dt>
			<dd className="whitespace-pre-wrap break-words text-sm">{children ?? "—"}</dd>
		</div>
	);
}

function ReviewAssetButton({ detail }: { detail: AssetDetail }) {
	const viewer = useGeoViewer();
	const queryClient = useQueryClient();
	const [decision, setDecision] = useState<"APPROVE" | "REJECT" | null>(null);
	const [note, setNote] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	if (!viewer.can("knowledge.review")) return null;
	const own = detail.asset.uploadedBy === viewer.actorId;

	const submit = async () => {
		if (!decision) return;
		setBusy(true);
		setError(null);
		try {
			await reviewKnowledgeAssetFn({
				data: { organizationId: viewer.organizationId, assetId: detail.asset.id, input: { decision, note } },
			});
			await queryClient.invalidateQueries({ queryKey: knowledgeKeys.all(viewer.organizationId) });
			setDecision(null);
			setNote("");
		} catch (err) {
			setError(errorMessage(err));
		} finally {
			setBusy(false);
		}
	};

	return (
		<>
			{detail.asset.approvalStatus !== "APPROVED" && (
				<Button
					size="sm"
					onClick={() => setDecision("APPROVE")}
					disabled={own}
					title={own ? "上传人不能确认自己上传的资料" : undefined}
				>
					确认原件
				</Button>
			)}
			{detail.asset.approvalStatus !== "REJECTED" && (
				<Button size="sm" variant="outline" onClick={() => setDecision("REJECT")}>
					驳回资料
				</Button>
			)}
			<Dialog open={decision !== null} onOpenChange={(open) => !open && setDecision(null)}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>{decision === "APPROVE" ? "确认原件" : "驳回资料"}</DialogTitle>
						<DialogDescription>
							{decision === "APPROVE"
								? "确认这份资料是客户提供的有效原件。高风险事实只认已确认且在有效期内的原件。"
								: "驳回后，这份资料不再作为任何事实的有效来源；依赖它的已审核事实会转入复核。"}
						</DialogDescription>
					</DialogHeader>
					<div className="space-y-1">
						<Label htmlFor="asset-review-note">依据</Label>
						<Textarea id="asset-review-note" rows={3} value={note} onChange={(event) => setNote(event.target.value)} />
					</div>
					{error && (
						<Alert variant="destructive">
							<AlertDescription>{error}</AlertDescription>
						</Alert>
					)}
					<DialogFooter>
						<Button variant="outline" onClick={() => setDecision(null)} disabled={busy}>
							取消
						</Button>
						<Button
							onClick={submit}
							disabled={busy || !note.trim()}
							variant={decision === "REJECT" ? "destructive" : "default"}
						>
							{busy ? "提交中…" : "确认"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}

function EditValidityButton({ detail }: { detail: AssetDetail }) {
	const viewer = useGeoViewer();
	const queryClient = useQueryClient();
	const [open, setOpen] = useState(false);
	const [validUntil, setValidUntil] = useState(detail.asset.validUntil?.slice(0, 10) ?? "");
	const [error, setError] = useState<string | null>(null);
	if (!viewer.can("knowledge.write")) return null;
	const save = async () => {
		setError(null);
		try {
			await updateKnowledgeAssetFn({
				data: {
					organizationId: viewer.organizationId,
					assetId: detail.asset.id,
					input: { validUntil: validUntil || null },
				},
			});
			await queryClient.invalidateQueries({ queryKey: knowledgeKeys.all(viewer.organizationId) });
			setOpen(false);
		} catch (err) {
			setError(errorMessage(err));
		}
	};
	return (
		<>
			<Button size="sm" variant="outline" onClick={() => setOpen(true)}>
				修改有效期
			</Button>
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>修改有效期</DialogTitle>
						<DialogDescription>到期后，只由这份资料支撑的已审核事实会转为不可公开并进入复核。</DialogDescription>
					</DialogHeader>
					<Input type="date" value={validUntil} onChange={(event) => setValidUntil(event.target.value)} />
					{error && (
						<Alert variant="destructive">
							<AlertDescription>{error}</AlertDescription>
						</Alert>
					)}
					<DialogFooter>
						<Button variant="outline" onClick={() => setOpen(false)}>
							取消
						</Button>
						<Button onClick={save}>保存</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}

function EntityPicker({
	value,
	onChange,
}: {
	value: { id: string; title: string } | { kind: GeoSiteEntityKind; title: string } | null;
	onChange: (value: { id: string; title: string } | { kind: GeoSiteEntityKind; title: string } | null) => void;
}) {
	const viewer = useGeoViewer();
	const [kind, setKind] = useState<GeoSiteEntityKind | null>("PRODUCT");
	const [search, setSearch] = useState("");
	const q = useDebouncedValue(search.trim(), 300);
	const { data } = useQuery({
		queryKey: ["geo-knowledge", viewer.organizationId, "entities", kind, q],
		queryFn: () =>
			searchKnowledgeEntitiesFn({
				data: { organizationId: viewer.organizationId, input: { q: q || undefined, kind: kind ?? undefined } },
			}),
	});
	const exact = data?.some((entity) => entity.title === search.trim());
	return (
		<div className="flex flex-col gap-2">
			<div className="grid grid-cols-3 gap-2">
				<SimpleSelect
					value={kind}
					onChange={setKind}
					options={GEO_SITE_ENTITY_KINDS.map((option) => ({ value: option, label: ENTITY_KIND_LABELS[option] }))}
				/>
				<Input
					className="col-span-2"
					placeholder="型号、产品名、案例名，与官网实体归并"
					value={search}
					onChange={(event) => setSearch(event.target.value)}
				/>
			</div>
			<div className="flex max-h-40 flex-col gap-1 overflow-y-auto rounded-md border p-1">
				{(data ?? []).map((entity) => (
					<button
						type="button"
						key={entity.id}
						onClick={() => onChange({ id: entity.id, title: entity.title })}
						className={`rounded px-2 py-1 text-left text-sm hover:bg-muted ${value && "id" in value && value.id === entity.id ? "bg-muted font-medium" : ""}`}
					>
						{entity.title}
						<span className="ml-2 text-xs text-muted-foreground">
							{entityKindLabel(entity.kind)} · 官网 {entity.pageCount} 页
						</span>
					</button>
				))}
				{search.trim() && !exact && kind && (
					<button
						type="button"
						onClick={() => onChange({ kind, title: search.trim() })}
						className={`rounded px-2 py-1 text-left text-sm hover:bg-muted ${value && !("id" in value) ? "bg-muted font-medium" : ""}`}
					>
						新建{ENTITY_KIND_LABELS[kind]}：{search.trim()}
					</button>
				)}
				{(data ?? []).length === 0 && !search.trim() && (
					<span className="px-2 py-1 text-xs text-muted-foreground">输入名称搜索官网已有实体</span>
				)}
			</div>
			{value && <span className="text-xs text-muted-foreground">已选择：{value.title}</span>}
		</div>
	);
}

function registeredMessage(result: { created: boolean; conflicts: number }): string {
	const base = result.created ? "已登记新主张" : "相同取值的主张已存在，已追加本原件为来源";
	return result.conflicts > 0 ? `${base}；与已批准值不一致，已生成 ${result.conflicts} 个冲突审核项` : base;
}

function locatorInput(page: string, paragraph: string, quote: string) {
	return { page: page ? Number(page) : null, paragraph: paragraph || null, quote: quote || null };
}

function RegisterClaimForm({ detail }: { detail: AssetDetail }) {
	const viewer = useGeoViewer();
	const queryClient = useQueryClient();
	const [entity, setEntity] = useState<
		{ id: string; title: string } | { kind: GeoSiteEntityKind; title: string } | null
	>(null);
	const [claimType, setClaimType] = useState<GeoKnowledgeClaimType | null>("TECH_PARAMETER");
	const [fieldPath, setFieldPath] = useState("");
	const [claimText, setClaimText] = useState("");
	const [value, setValue] = useState("");
	const [page, setPage] = useState("");
	const [paragraph, setParagraph] = useState("");
	const [quote, setQuote] = useState("");
	const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
	const [busy, setBusy] = useState(false);

	const submit = async () => {
		if (!entity || !claimType) return;
		setBusy(true);
		setMessage(null);
		try {
			const result = await registerAssetClaimFn({
				data: {
					organizationId: viewer.organizationId,
					assetId: detail.asset.id,
					input: {
						entity: "id" in entity ? { id: entity.id } : { kind: entity.kind, title: entity.title },
						claimType,
						fieldPath: fieldPath.trim(),
						claimText,
						value: value || null,
						locator: locatorInput(page, paragraph, quote),
					},
				},
			});
			await queryClient.invalidateQueries({ queryKey: knowledgeKeys.all(viewer.organizationId) });
			setMessage({ kind: "ok", text: registeredMessage(result) });
			setClaimText("");
			setValue("");
			setQuote("");
		} catch (err) {
			setMessage({ kind: "error", text: errorMessage(err) });
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="flex flex-col gap-3">
			<div className="space-y-1">
				<Label>实体</Label>
				<EntityPicker value={entity} onChange={setEntity} />
			</div>
			<div className="grid gap-2 md:grid-cols-2">
				<div className="space-y-1">
					<Label htmlFor="claim-type">主张类型</Label>
					<SimpleSelect
						id="claim-type"
						value={claimType}
						onChange={setClaimType}
						options={GEO_KNOWLEDGE_CLAIM_TYPES.map((option) => ({ value: option, label: CLAIM_TYPE_LABELS[option] }))}
					/>
				</div>
				<div className="space-y-1">
					<Label htmlFor="claim-field">字段路径</Label>
					<Input
						id="claim-field"
						value={fieldPath}
						placeholder={claimType ? (CLAIM_TYPE_FIELD_HINTS[claimType] ?? "field") : "field"}
						onChange={(event) => setFieldPath(event.target.value)}
					/>
				</div>
			</div>
			<p className="text-xs text-muted-foreground">
				字段路径与官网解析结果一致时（例如同一型号的同一参数），原件和官网的取值会归并对比；取值不同会生成冲突审核项。
			</p>
			<div className="space-y-1">
				<Label htmlFor="claim-text">主张原文</Label>
				<Textarea id="claim-text" rows={2} value={claimText} onChange={(event) => setClaimText(event.target.value)} />
			</div>
			<div className="space-y-1">
				<Label htmlFor="claim-value">规范化取值（可选，默认取主张原文）</Label>
				<Input
					id="claim-value"
					value={value}
					onChange={(event) => setValue(event.target.value)}
					placeholder="例如 12kV"
				/>
			</div>
			<div className="grid grid-cols-2 gap-2">
				<div className="space-y-1">
					<Label htmlFor="claim-page">页码</Label>
					<Input
						id="claim-page"
						inputMode="numeric"
						value={page}
						onChange={(event) => setPage(event.target.value.replace(/\D/g, ""))}
					/>
				</div>
				<div className="space-y-1">
					<Label htmlFor="claim-paragraph">段落 / 表格位置</Label>
					<Input id="claim-paragraph" value={paragraph} onChange={(event) => setParagraph(event.target.value)} />
				</div>
			</div>
			<div className="space-y-1">
				<Label htmlFor="claim-quote">原文摘录（可选）</Label>
				<Textarea id="claim-quote" rows={2} value={quote} onChange={(event) => setQuote(event.target.value)} />
			</div>
			{message && (
				<Alert variant={message.kind === "error" ? "destructive" : "default"}>
					<AlertDescription>{message.text}</AlertDescription>
				</Alert>
			)}
			<div>
				<Button
					onClick={submit}
					disabled={busy || !entity || !claimType || !fieldPath.trim() || !claimText.trim() || (!page && !paragraph)}
				>
					{busy ? "登记中…" : "登记主张"}
				</Button>
			</div>
		</div>
	);
}

export function AssetDetailView({ detail }: { detail: AssetDetail }) {
	const { organization } = useRouteContext({ from: "/_authed/app/org/$org/geo" });
	const viewer = useGeoViewer();
	const { asset } = detail;
	const usable = asset.approvalStatus !== "REJECTED" && asset.scanStatus !== "INFECTED";
	return (
		<div className="flex flex-col gap-4">
			<Card>
				<CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
					<CardTitle className="text-base">资料信息</CardTitle>
					<div className="flex flex-wrap gap-2">
						<a
							href={`/api/geo/${encodeURIComponent(organization.slug)}/knowledge-assets/${asset.id}/file`}
							className={buttonVariants({ variant: "outline", size: "sm" })}
						>
							下载原件
						</a>
						<EditValidityButton detail={detail} />
						<ReviewAssetButton detail={detail} />
					</div>
				</CardHeader>
				<CardContent className="flex flex-col gap-4">
					<AssetStatusBadges asset={asset} />
					{asset.scanStatus === "UNSCANNED" && (
						<Alert>
							<AlertTitle>未经恶意文件扫描</AlertTitle>
							<AlertDescription>上传时部署没有配置扫描服务。打开前请确认来源可信。</AlertDescription>
						</Alert>
					)}
					<dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
						<Field label="资料类型">{ASSET_TYPE_LABELS[asset.assetType]}</Field>
						<Field label="文件">
							{asset.fileName} · {formatBytes(asset.size)}
						</Field>
						<Field label="保密级别">
							<ScopeBadge scope={asset.confidentiality} />
						</Field>
						<Field label="内容可公开范围">
							<ScopeBadge scope={asset.publicationScope} />
						</Field>
						<Field label="有效期至">{formatDate(asset.validUntil)}</Field>
						<Field label="上传">
							{asset.uploadedByName} · {formatDateTime(asset.createdAt)}
						</Field>
						<Field label="确认">
							{asset.reviewedByName ? `${asset.reviewedByName} · ${formatDateTime(asset.reviewedAt)}` : "—"}
						</Field>
						<Field label="SHA-256">
							<span className="font-mono text-xs">{asset.sha256}</span>
						</Field>
					</dl>
					{asset.description && <p className="text-sm">{asset.description}</p>}
					{asset.reviewNote && <p className="text-sm text-muted-foreground">确认意见：{asset.reviewNote}</p>}
				</CardContent>
			</Card>
			{viewer.can("knowledge.write") && usable && (
				<Card>
					<CardHeader>
						<CardTitle className="text-base">在原件上登记主张</CardTitle>
						<CardDescription>
							从原件中摘出一条可核对的主张，并标明页码或段落。登记后进入待审核；同一实体同一字段的取值与官网来源归并。
						</CardDescription>
					</CardHeader>
					<CardContent>
						<RegisterClaimForm detail={detail} />
					</CardContent>
				</Card>
			)}
			<Card>
				<CardHeader>
					<CardTitle className="text-base">由此原件支撑的主张</CardTitle>
				</CardHeader>
				<CardContent>
					{detail.claims.length === 0 ? (
						<GeoEmptyState title="还没有登记主张" />
					) : (
						<ul className="divide-y">
							{detail.claims.map((claim) => (
								<li key={claim.id} className="flex flex-col gap-1 py-2 text-sm">
									<div className="flex flex-wrap items-center gap-2">
										<GeoAssertionStatusBadge status={claim.status} />
										<Link
											to="/app/org/$org/geo/knowledge/$id"
											params={{ org: organization.slug, id: claim.id }}
											className="font-medium hover:underline"
										>
											{claim.claimText}
										</Link>
									</div>
									<span className="text-xs text-muted-foreground">
										{claim.entityTitle ?? "—"} · {claimTypeLabel(claim.claimType)} · {claim.fieldPath ?? "—"}
										{typeof claim.locator.page === "number" ? ` · 第 ${claim.locator.page} 页` : ""}
										{typeof claim.locator.paragraph === "string" ? ` · ${claim.locator.paragraph}` : ""}
									</span>
								</li>
							))}
						</ul>
					)}
				</CardContent>
			</Card>
		</div>
	);
}
