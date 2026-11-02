import { IconAlertTriangle, IconExternalLink } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { GEO_RUN_STATUS_LABELS, type GeoRunStatus } from "@workspace/geo-domain";
import { Alert, AlertDescription, AlertTitle } from "@workspace/ui/components/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@workspace/ui/components/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@workspace/ui/components/table";
import type { ReactNode } from "react";
import { formatCost, formatDateTime, formatDuration } from "@/components/geo/sampling/format";
import { useGeoOrganization } from "@/components/geo/sampling/use-geo-organization";
import { GeoModelApiNotice, GeoUnverifiedTargetNotice } from "@/components/geo/shell/notices";
import type { ObservationDetail } from "@/server/geo/observations-core";

function Fact({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="flex flex-col gap-0.5">
			<dt className="text-xs text-muted-foreground">{label}</dt>
			<dd className="text-sm break-all">{children ?? "—"}</dd>
		</div>
	);
}

function isWebUrl(value: string): boolean {
	return /^https?:\/\//i.test(value);
}

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
	return (
		<a
			href={href}
			target="_blank"
			rel="noopener noreferrer nofollow"
			className="inline-flex items-center gap-1 underline"
		>
			{children}
			<IconExternalLink className="size-3.5 shrink-0" />
		</a>
	);
}

function metadataText(metadata: ObservationDetail["responseMetadata"], key: string): string | null {
	const value = metadata[key];
	return typeof value === "string" && value ? value : null;
}

export function ObservationNotices({ observation }: { observation: ObservationDetail }) {
	return (
		<div className="flex flex-col gap-3">
			{observation.target.surfaceMode === "MODEL_API" && <GeoModelApiNotice />}
			<GeoUnverifiedTargetNotice
				status={observation.target.verificationStatus as "UNVERIFIED" | "LIMITED" | "PASSED" | "FAILED"}
				note={observation.target.verificationNote}
			/>
			{!observation.countsInRates && (
				<Alert>
					<IconAlertTriangle />
					<AlertTitle>此样本不计入比率</AlertTitle>
					<AlertDescription>
						状态为“{GEO_RUN_STATUS_LABELS[observation.status as GeoRunStatus]}”
						{observation.errorCode ? `（${observation.errorCode}）` : ""}
						。失败、限流、验证码、不可用和不完整的回答都不计入分母，也不会被当作“未提及”。
					</AlertDescription>
				</Alert>
			)}
		</div>
	);
}

export function ObservationAnswer({ observation }: { observation: ObservationDetail }) {
	return (
		<Card>
			<CardHeader>
				<CardTitle>原始问题与回答</CardTitle>
				<CardDescription>
					采样于 {formatDateTime(observation.sampledAt)}
					{observation.promptSet &&
						`，问法集 ${observation.promptSet.name} · v${observation.promptSet.version}，问法修订 ${observation.promptRevision}`}
				</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				<div>
					<p className="mb-1 text-xs text-muted-foreground">问题</p>
					<p className="text-sm font-medium">{observation.questionText}</p>
				</div>
				<div>
					<p className="mb-1 text-xs text-muted-foreground">回答原文</p>
					{observation.responseText ? (
						<div className="max-h-[32rem] overflow-y-auto rounded-md border bg-muted/30 p-4 text-sm whitespace-pre-wrap">
							{observation.responseText}
						</div>
					) : (
						<p className="text-sm text-muted-foreground">没有取得回答。</p>
					)}
				</div>
			</CardContent>
		</Card>
	);
}

export function ObservationCitations({ observation }: { observation: ObservationDetail }) {
	return (
		<Card>
			<CardHeader>
				<CardTitle>引用来源</CardTitle>
				<CardDescription>
					{observation.citations.length ? `共 ${observation.citations.length} 条` : "该回答未提供引用"}
				</CardDescription>
			</CardHeader>
			{observation.citations.length > 0 && (
				<CardContent>
					<ol className="flex list-decimal flex-col gap-2 pl-5 text-sm">
						{observation.citations.map((citation) => (
							<li key={citation.ordinal}>
								<ExternalLink href={citation.url}>{citation.title ?? citation.url}</ExternalLink>
								<span className="ml-2 text-xs text-muted-foreground">{citation.host}</span>
							</li>
						))}
					</ol>
				</CardContent>
			)}
		</Card>
	);
}

function EvidenceLocation({ observation }: { observation: ObservationDetail }) {
	const organization = useGeoOrganization();
	const { evidence } = observation;
	if (evidence.kind === "object") {
		return (
			<ExternalLink href={`/api/geo/${encodeURIComponent(organization.slug)}/observations/${observation.id}/evidence`}>
				{observation.import ? "查看上传的证据文件" : "下载原始响应"}
			</ExternalLink>
		);
	}
	if (evidence.kind === "url" && evidence.location && isWebUrl(evidence.location)) {
		return <ExternalLink href={evidence.location}>{evidence.location}</ExternalLink>;
	}
	return <>{evidence.location ?? "—"}</>;
}

export function ObservationProvenance({ observation }: { observation: ObservationDetail }) {
	const organization = useGeoOrganization();
	const metadata = observation.responseMetadata;
	const brief = (item: { id: string; status: string; sampledAt: string }) => (
		<Link
			key={item.id}
			to="/app/org/$org/geo/observations/$id"
			params={{ org: organization.slug, id: item.id }}
			className="underline"
		>
			{formatDateTime(item.sampledAt)}（{GEO_RUN_STATUS_LABELS[item.status as GeoRunStatus] ?? item.status}）
		</Link>
	);

	return (
		<Card>
			<CardHeader>
				<CardTitle>采样与证据</CardTitle>
				<CardDescription>记录写入后不可修改。</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				<dl className="grid gap-4 sm:grid-cols-3">
					<Fact label="服务方">{observation.target.provider}</Fact>
					<Fact label="配置的模型">{observation.target.modelId}</Fact>
					<Fact label="返回的模型 / 应用版本">{observation.modelVersion}</Fact>
					<Fact label="地区 / 语言">
						{[observation.target.region, observation.target.language].filter(Boolean).join(" / ")}
					</Fact>
					<Fact label="采集方法版本">{observation.sourceMethodVersion}</Fact>
					<Fact label="服务方追踪 ID">{metadataText(metadata, "providerTraceId")}</Fact>
					{metadataText(metadata, "serviceName") && (
						<Fact label="许可服务">{metadataText(metadata, "serviceName")}</Fact>
					)}
					{metadataText(metadata, "note") && <Fact label="导入备注">{metadataText(metadata, "note")}</Fact>}
					<Fact label="证据位置">
						<EvidenceLocation observation={observation} />
					</Fact>
					{observation.import && <Fact label="导入批次">{observation.import.importBatchId}</Fact>}
					{observation.retryOf && <Fact label="重采自">{brief(observation.retryOf)}</Fact>}
					{observation.resamples.length > 0 && (
						<Fact label="后续重采">
							<span className="flex flex-col gap-1">{observation.resamples.map(brief)}</span>
						</Fact>
					)}
				</dl>
				{observation.run && observation.run.attempts.length > 0 && (
					<div>
						<p className="mb-2 text-xs text-muted-foreground">
							尝试记录（第 {observation.run.repeatIndex + 1} 次重复）
						</p>
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>尝试</TableHead>
									<TableHead>开始时间</TableHead>
									<TableHead>耗时</TableHead>
									<TableHead>状态</TableHead>
									<TableHead>错误</TableHead>
									<TableHead>费用估算</TableHead>
									<TableHead>追踪 ID</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{observation.run.attempts.map((attempt) => (
									<TableRow key={attempt.attemptNo}>
										<TableCell className="tabular-nums">#{attempt.attemptNo}</TableCell>
										<TableCell className="whitespace-nowrap">{formatDateTime(attempt.startedAt)}</TableCell>
										<TableCell className="tabular-nums">{formatDuration(attempt.durationMs)}</TableCell>
										<TableCell>{GEO_RUN_STATUS_LABELS[attempt.status as GeoRunStatus] ?? attempt.status}</TableCell>
										<TableCell className="text-xs">{attempt.errorCode ?? "—"}</TableCell>
										<TableCell className="tabular-nums">{formatCost(attempt.costEstimate)}</TableCell>
										<TableCell className="max-w-40 truncate text-xs">{attempt.providerTraceId ?? "—"}</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					</div>
				)}
			</CardContent>
		</Card>
	);
}
