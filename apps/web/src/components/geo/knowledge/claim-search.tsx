import {
	GEO_ASSERTION_STATUS_LABELS,
	GEO_KNOWLEDGE_CLAIM_TYPES,
	GEO_SITE_ENTITY_KINDS,
	type GeoAssertionStatus,
	type GeoKnowledgeClaimType,
	type GeoRiskLevel,
	type GeoSiteEntityKind,
} from "@workspace/geo-domain";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@workspace/ui/components/card";
import { Input } from "@workspace/ui/components/input";
import { useState } from "react";
import { SimpleSelect } from "@/components/geo/tasks/simple-select";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import type { ClaimFilters } from "@/server/geo/knowledge-core";
import { ClaimTable, NoClaims } from "./claim-table";
import { CLAIM_TYPE_LABELS, ENTITY_KIND_LABELS } from "./labels";
import { useKnowledgeClaims } from "./queries";

type SourceKind = "PAGE_VERSION" | "ASSET";

function useFilterState() {
	const [search, setSearch] = useState("");
	const [entityKind, setEntityKind] = useState<GeoSiteEntityKind | null>(null);
	const [claimType, setClaimType] = useState<GeoKnowledgeClaimType | null>(null);
	const [riskLevel, setRiskLevel] = useState<GeoRiskLevel | null>(null);
	const [sourceKind, setSourceKind] = useState<SourceKind | null>(null);
	const q = useDebouncedValue(search.trim(), 300);
	const filters: ClaimFilters = {
		q: q || undefined,
		entityKind: entityKind ?? undefined,
		claimType: claimType ?? undefined,
		riskLevel: riskLevel ?? undefined,
		sourceKind: sourceKind ?? undefined,
	};
	const controls = (
		<div className="grid grid-cols-2 gap-2 md:grid-cols-5">
			<Input
				placeholder="关键词，如型号、参数、证书名"
				value={search}
				onChange={(event) => setSearch(event.target.value)}
			/>
			<SimpleSelect
				value={entityKind}
				onChange={setEntityKind}
				noneLabel="全部实体类型"
				options={GEO_SITE_ENTITY_KINDS.map((value) => ({ value, label: ENTITY_KIND_LABELS[value] }))}
			/>
			<SimpleSelect
				value={claimType}
				onChange={setClaimType}
				noneLabel="全部主张类型"
				options={GEO_KNOWLEDGE_CLAIM_TYPES.map((value) => ({ value, label: CLAIM_TYPE_LABELS[value] }))}
			/>
			<SimpleSelect
				value={riskLevel}
				onChange={setRiskLevel}
				noneLabel="全部风险"
				options={[
					{ value: "HIGH", label: "高风险" },
					{ value: "NORMAL", label: "普通" },
				]}
			/>
			<SimpleSelect
				value={sourceKind}
				onChange={setSourceKind}
				noneLabel="全部来源"
				options={[
					{ value: "PAGE_VERSION", label: "官网页面" },
					{ value: "ASSET", label: "客户原件" },
				]}
			/>
		</div>
	);
	return { filters, controls };
}

/**
 * Two separate result sets, never merged: reviewed facts that may be used, and
 * what pages or documents say that nobody has confirmed yet (PRD 3.12).
 */
export function ClaimSearch({ organizationId }: { organizationId: string }) {
	const { filters, controls } = useFilterState();
	const [approvedPage, setApprovedPage] = useState(1);
	const [pendingPage, setPendingPage] = useState(1);
	const filterKey = JSON.stringify(filters);
	const [lastKey, setLastKey] = useState(filterKey);
	if (lastKey !== filterKey) {
		setLastKey(filterKey);
		setApprovedPage(1);
		setPendingPage(1);
	}
	const approved = useKnowledgeClaims(organizationId, { ...filters, verified: true }, approvedPage, { limit: 10 });
	const unreviewed = useKnowledgeClaims(organizationId, { ...filters, verified: false }, pendingPage, { limit: 10 });

	return (
		<div className="flex flex-col gap-4">
			{controls}
			<Card>
				<CardHeader>
					<CardTitle className="text-base">已审核事实</CardTitle>
					<CardDescription>
						审核通过且在有效期内的事实，附页面和字段级引用。只有其中“可公开”的事实能用于对外草稿。
					</CardDescription>
				</CardHeader>
				<CardContent>
					<ClaimTable
						data={approved.data}
						isLoading={approved.isLoading}
						error={approved.error}
						page={approvedPage}
						onPageChange={setApprovedPage}
						empty={<NoClaims title="没有符合条件的已审核事实" />}
					/>
				</CardContent>
			</Card>
			<Card>
				<CardHeader>
					<CardTitle className="text-base">未审核内容</CardTitle>
					<CardDescription>
						来自官网页面或客户资料、尚未审核通过的内容。仅供核对，不能作为事实对外使用。
					</CardDescription>
				</CardHeader>
				<CardContent>
					<ClaimTable
						data={unreviewed.data}
						isLoading={unreviewed.isLoading}
						error={unreviewed.error}
						page={pendingPage}
						onPageChange={setPendingPage}
						empty={<NoClaims title="没有符合条件的未审核内容" />}
					/>
				</CardContent>
			</Card>
		</div>
	);
}

const PENDING_STATUSES: GeoAssertionStatus[] = ["PENDING_REVIEW", "NEEDS_EVIDENCE", "SOURCE_UNAVAILABLE"];

/** The reviewer's queue, high-risk claims first. */
export function ClaimReviewQueue({ organizationId }: { organizationId: string }) {
	const { filters, controls } = useFilterState();
	const [status, setStatus] = useState<GeoAssertionStatus | null>(null);
	const [page, setPage] = useState(1);
	const query = useKnowledgeClaims(organizationId, { ...filters, status: status ? [status] : undefined }, page, {
		pendingOnly: true,
	});
	return (
		<div className="flex flex-col gap-3">
			{controls}
			<div className="w-60">
				<SimpleSelect
					value={status}
					onChange={(value) => {
						setStatus(value);
						setPage(1);
					}}
					noneLabel="全部待处理状态"
					options={PENDING_STATUSES.map((value) => ({ value, label: GEO_ASSERTION_STATUS_LABELS[value] }))}
				/>
			</div>
			<ClaimTable
				data={query.data}
				isLoading={query.isLoading}
				error={query.error}
				page={page}
				onPageChange={setPage}
				empty={<NoClaims title="没有待审核的事实" description="官网采集或资料录入的新主张会出现在这里。" />}
			/>
		</div>
	);
}
