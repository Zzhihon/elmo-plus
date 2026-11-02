import {
	GEO_PROMPT_STATUS_LABELS,
	GEO_PROMPT_STATUSES,
	GEO_PROMPT_TIER_LABELS,
	GEO_PROMPT_TIERS,
	type GeoPromptStatus,
	type GeoPromptTier,
} from "@workspace/geo-domain";
import { Button } from "@workspace/ui/components/button";
import { Input } from "@workspace/ui/components/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@workspace/ui/components/select";
import { Download, Plus, Upload } from "lucide-react";
import type { GeoBuyerRole } from "@/server/geo/prompts-core";

export const ALL = "ALL";

export function PromptFilters({
	roles,
	search,
	status,
	tier,
	roleId,
	onSearch,
	onStatus,
	onTier,
	onRole,
}: {
	roles: GeoBuyerRole[];
	search: string;
	status: string;
	tier: string;
	roleId: string;
	onSearch: (value: string) => void;
	onStatus: (value: unknown) => void;
	onTier: (value: unknown) => void;
	onRole: (value: unknown) => void;
}) {
	return (
		<div className="flex flex-wrap items-center gap-2">
			<Input
				className="w-64"
				placeholder="搜索问法"
				value={search}
				onChange={(event) => onSearch(event.target.value)}
			/>
			<Select items={{ [ALL]: "全部状态", ...GEO_PROMPT_STATUS_LABELS }} value={status} onValueChange={onStatus}>
				<SelectTrigger className="w-36">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value={ALL}>全部状态</SelectItem>
					{GEO_PROMPT_STATUSES.map((value) => (
						<SelectItem key={value} value={value}>
							{GEO_PROMPT_STATUS_LABELS[value]}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			<Select items={{ [ALL]: "全部层级", ...GEO_PROMPT_TIER_LABELS }} value={tier} onValueChange={onTier}>
				<SelectTrigger className="w-32">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value={ALL}>全部层级</SelectItem>
					{GEO_PROMPT_TIERS.map((value) => (
						<SelectItem key={value} value={value}>
							{GEO_PROMPT_TIER_LABELS[value]}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			<Select
				items={{ [ALL]: "全部角色", ...Object.fromEntries(roles.map((role) => [role.id, role.title])) }}
				value={roleId}
				onValueChange={onRole}
			>
				<SelectTrigger className="w-44">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value={ALL}>全部角色</SelectItem>
					{roles.map((role) => (
						<SelectItem key={role.id} value={role.id}>
							{role.title}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</div>
	);
}

export function QuestionActions({
	canWrite,
	exporting,
	onExport,
	onImport,
	onCreate,
}: {
	canWrite: boolean;
	exporting: boolean;
	onExport: () => void;
	onImport: () => void;
	onCreate: () => void;
}) {
	return (
		<>
			<Button variant="outline" disabled={exporting} onClick={onExport}>
				<Download className="size-4" />
				导出 CSV
			</Button>
			{canWrite && (
				<>
					<Button variant="outline" onClick={onImport}>
						<Upload className="size-4" />
						导入 CSV
					</Button>
					<Button onClick={onCreate}>
						<Plus className="size-4" />
						新建问法
					</Button>
				</>
			)}
		</>
	);
}

export function toPromptQuery(filters: { status: string; tier: string; roleId: string; search: string }) {
	const pick = <T extends string>(value: string) => (value === ALL ? undefined : (value as T));
	return {
		status: pick<GeoPromptStatus>(filters.status),
		tier: pick<GeoPromptTier>(filters.tier),
		buyerRoleId: pick<string>(filters.roleId),
		q: filters.search.trim() || undefined,
	};
}
