import { IconUpload } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useRouteContext } from "@tanstack/react-router";
import {
	GEO_ASSET_APPROVAL_STATUSES,
	GEO_ASSET_TYPES,
	GEO_KNOWLEDGE_FILE_TYPES,
	GEO_KNOWLEDGE_UPLOAD_MAX_BYTES,
	GEO_PUBLICATION_SCOPES,
	type GeoAssetApprovalStatus,
	type GeoAssetType,
	type GeoPublicationScope,
	scopeAllows,
} from "@workspace/geo-domain";
import { Alert, AlertDescription } from "@workspace/ui/components/alert";
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
import { Skeleton } from "@workspace/ui/components/skeleton";
import { Textarea } from "@workspace/ui/components/textarea";
import { useState } from "react";
import { GeoEmptyState } from "@/components/geo/shell/empty-state";
import { GeoPaginatedTable } from "@/components/geo/shell/paginated-table";
import { GeoStatusBadge } from "@/components/geo/shell/status-badge";
import { useGeoViewer } from "@/components/geo/shell/use-geo-viewer";
import { GeoScanStatusBadge } from "@/components/geo/tasks/scan-status-badge";
import { SimpleSelect } from "@/components/geo/tasks/simple-select";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import type { KnowledgeAssetView } from "@/server/geo/knowledge-assets-core";
import { ScopeBadge } from "./citations";
import {
	ASSET_APPROVAL_LABELS,
	ASSET_APPROVAL_TONES,
	ASSET_TYPE_LABELS,
	errorMessage,
	formatBytes,
	formatDate,
	formatDateTime,
	SCOPE_LABELS,
} from "./labels";
import { knowledgeKeys, useKnowledgeAssets } from "./queries";

const ACCEPT = [...GEO_KNOWLEDGE_FILE_TYPES.map((type) => type.mime), ".doc", ".docx"].join(",");

export function AssetStatusBadges({ asset }: { asset: KnowledgeAssetView }) {
	return (
		<div className="flex flex-wrap gap-1">
			<GeoStatusBadge
				label={ASSET_APPROVAL_LABELS[asset.approvalStatus]}
				tone={ASSET_APPROVAL_TONES[asset.approvalStatus]}
			/>
			<GeoScanStatusBadge status={asset.scanStatus} />
			{asset.expired && <GeoStatusBadge label="已过期" tone="danger" />}
		</div>
	);
}

interface UploadResponse {
	data?: { asset: { id: string }; created: boolean };
	error?: { message?: string };
}

async function postAsset(orgSlug: string, file: File, fields: Record<string, string>): Promise<Response> {
	const body = new FormData();
	body.append("file", file);
	for (const [name, value] of Object.entries(fields)) {
		if (value) body.append(name, value);
	}
	return fetch(`/api/geo/${encodeURIComponent(orgSlug)}/knowledge-assets`, { method: "POST", body });
}

function UploadDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
	const { organization } = useRouteContext({ from: "/_authed/app/org/$org/geo" });
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const [file, setFile] = useState<File | null>(null);
	const [title, setTitle] = useState("");
	const [assetType, setAssetType] = useState<GeoAssetType | null>("PRODUCT_SPEC");
	const [confidentiality, setConfidentiality] = useState<GeoPublicationScope | null>("INTERNAL");
	const [publicationScope, setPublicationScope] = useState<GeoPublicationScope | null>("INTERNAL");
	const [validUntil, setValidUntil] = useState("");
	const [description, setDescription] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const scopeOptions = GEO_PUBLICATION_SCOPES.filter(
		(scope) => !confidentiality || scopeAllows(confidentiality, scope),
	).map((value) => ({ value, label: SCOPE_LABELS[value] }));

	const submit = async () => {
		if (!file || !assetType || !confidentiality || !publicationScope) return;
		if (file.size > GEO_KNOWLEDGE_UPLOAD_MAX_BYTES) {
			setError(`文件不能超过 ${GEO_KNOWLEDGE_UPLOAD_MAX_BYTES / 1024 / 1024} MB`);
			return;
		}
		setBusy(true);
		setError(null);
		try {
			const response = await postAsset(organization.slug, file, {
				title: title || file.name,
				assetType,
				confidentiality,
				publicationScope,
				validUntil,
				description,
			});
			const payload = (await response.json().catch(() => null)) as UploadResponse | null;
			if (!response.ok || !payload?.data) throw new Error(payload?.error?.message ?? "上传失败");
			await queryClient.invalidateQueries({ queryKey: knowledgeKeys.all(organization.id) });
			onOpenChange(false);
			await navigate({
				to: "/app/org/$org/geo/knowledge/assets/$assetId",
				params: { org: organization.slug, assetId: payload.data.asset.id },
			});
		} catch (err) {
			setError(errorMessage(err));
		} finally {
			setBusy(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>上传客户资料</DialogTitle>
					<DialogDescription>
						支持 PDF、Word、PNG、JPEG、WebP，单个文件不超过 {GEO_KNOWLEDGE_UPLOAD_MAX_BYTES / 1024 / 1024} MB。
						文件会经过恶意文件扫描，原件只能通过工作台鉴权下载。
					</DialogDescription>
				</DialogHeader>
				<div className="flex flex-col gap-3">
					<div className="space-y-1">
						<Label htmlFor="asset-file">文件</Label>
						<Input
							id="asset-file"
							type="file"
							accept={ACCEPT}
							onChange={(event) => {
								const next = event.target.files?.[0] ?? null;
								setFile(next);
								if (next && !title) setTitle(next.name.replace(/\.[^.]+$/, ""));
							}}
						/>
					</div>
					<div className="space-y-1">
						<Label htmlFor="asset-title">资料名称</Label>
						<Input id="asset-title" value={title} onChange={(event) => setTitle(event.target.value)} />
					</div>
					<div className="grid grid-cols-2 gap-2">
						<div className="space-y-1">
							<Label htmlFor="asset-type">资料类型</Label>
							<SimpleSelect
								id="asset-type"
								value={assetType}
								onChange={setAssetType}
								options={GEO_ASSET_TYPES.map((value) => ({ value, label: ASSET_TYPE_LABELS[value] }))}
							/>
						</div>
						<div className="space-y-1">
							<Label htmlFor="asset-valid">有效期至（可选）</Label>
							<Input
								id="asset-valid"
								type="date"
								value={validUntil}
								onChange={(event) => setValidUntil(event.target.value)}
							/>
						</div>
						<div className="space-y-1">
							<Label htmlFor="asset-confidentiality">保密级别</Label>
							<SimpleSelect
								id="asset-confidentiality"
								value={confidentiality}
								onChange={(value) => {
									setConfidentiality(value);
									if (value && publicationScope && !scopeAllows(value, publicationScope)) setPublicationScope(value);
								}}
								options={GEO_PUBLICATION_SCOPES.map((value) => ({ value, label: SCOPE_LABELS[value] }))}
							/>
						</div>
						<div className="space-y-1">
							<Label htmlFor="asset-scope">内容可公开范围</Label>
							<SimpleSelect
								id="asset-scope"
								value={publicationScope}
								onChange={setPublicationScope}
								options={scopeOptions}
							/>
						</div>
					</div>
					<p className="text-xs text-muted-foreground">
						“可公开范围”限定从这份资料录入的事实最多能公开到哪一级；保密资料中的内容不会进入对外草稿或大模型。
					</p>
					<div className="space-y-1">
						<Label htmlFor="asset-description">说明（可选）</Label>
						<Textarea
							id="asset-description"
							rows={2}
							value={description}
							onChange={(event) => setDescription(event.target.value)}
						/>
					</div>
					{error && (
						<Alert variant="destructive">
							<AlertDescription>{error}</AlertDescription>
						</Alert>
					)}
				</div>
				<DialogFooter>
					<Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
						取消
					</Button>
					<Button onClick={submit} disabled={busy || !file || !assetType}>
						{busy ? "上传中…" : "上传"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

export function UploadAssetButton() {
	const viewer = useGeoViewer();
	const [open, setOpen] = useState(false);
	if (!viewer.can("knowledge.write")) return null;
	return (
		<>
			<Button size="sm" onClick={() => setOpen(true)}>
				<IconUpload className="size-4" />
				上传资料
			</Button>
			{open && <UploadDialog open={open} onOpenChange={setOpen} />}
		</>
	);
}

export function AssetList({ organizationId }: { organizationId: string }) {
	const { organization } = useRouteContext({ from: "/_authed/app/org/$org/geo" });
	const [search, setSearch] = useState("");
	const [assetType, setAssetType] = useState<GeoAssetType | null>(null);
	const [approvalStatus, setApprovalStatus] = useState<GeoAssetApprovalStatus | null>(null);
	const [page, setPage] = useState(1);
	const q = useDebouncedValue(search.trim(), 300);
	const { data, isLoading, error } = useKnowledgeAssets(
		organizationId,
		{ q: q || undefined, assetType: assetType ?? undefined, approvalStatus: approvalStatus ?? undefined },
		page,
	);
	return (
		<div className="flex flex-col gap-3">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<div className="grid flex-1 grid-cols-1 gap-2 md:grid-cols-3">
					<Input
						placeholder="搜索资料名称或文件名"
						value={search}
						onChange={(event) => {
							setSearch(event.target.value);
							setPage(1);
						}}
					/>
					<SimpleSelect
						value={assetType}
						onChange={(value) => {
							setAssetType(value);
							setPage(1);
						}}
						noneLabel="全部类型"
						options={GEO_ASSET_TYPES.map((value) => ({ value, label: ASSET_TYPE_LABELS[value] }))}
					/>
					<SimpleSelect
						value={approvalStatus}
						onChange={(value) => {
							setApprovalStatus(value);
							setPage(1);
						}}
						noneLabel="全部确认状态"
						options={GEO_ASSET_APPROVAL_STATUSES.map((value) => ({ value, label: ASSET_APPROVAL_LABELS[value] }))}
					/>
				</div>
				<UploadAssetButton />
			</div>
			{error && (
				<Alert variant="destructive">
					<AlertDescription>{errorMessage(error)}</AlertDescription>
				</Alert>
			)}
			{isLoading && !data ? (
				<Skeleton className="h-48 w-full" />
			) : (
				<GeoPaginatedTable<KnowledgeAssetView & { claimCount: number }>
					rows={data?.rows ?? []}
					total={data?.total ?? 0}
					page={page}
					totalPages={data?.totalPages ?? 1}
					onPageChange={setPage}
					rowKey={(asset) => asset.id}
					empty={<GeoEmptyState title="还没有客户资料" description="上传产品手册、资质证书、案例材料等原件。" />}
					columns={[
						{
							key: "title",
							header: "资料",
							cell: (asset) => (
								<div className="flex flex-col">
									<Link
										to="/app/org/$org/geo/knowledge/assets/$assetId"
										params={{ org: organization.slug, assetId: asset.id }}
										className="font-medium hover:underline"
									>
										{asset.title}
									</Link>
									<span className="text-xs text-muted-foreground">
										{asset.fileName} · {formatBytes(asset.size)}
									</span>
								</div>
							),
						},
						{ key: "type", header: "类型", cell: (asset) => ASSET_TYPE_LABELS[asset.assetType] },
						{ key: "status", header: "状态", cell: (asset) => <AssetStatusBadges asset={asset} /> },
						{
							key: "scope",
							header: "保密 / 可公开",
							cell: (asset) => (
								<div className="flex flex-wrap gap-1">
									<ScopeBadge scope={asset.confidentiality} />
									<ScopeBadge scope={asset.publicationScope} />
								</div>
							),
						},
						{ key: "valid", header: "有效期至", cell: (asset) => formatDate(asset.validUntil) },
						{ key: "claims", header: "已录入主张", cell: (asset) => asset.claimCount },
						{
							key: "uploaded",
							header: "上传",
							cell: (asset) => (
								<span className="text-xs">
									{asset.uploadedByName}
									<br />
									{formatDateTime(asset.createdAt)}
								</span>
							),
						},
					]}
				/>
			)}
		</div>
	);
}
