import { useQueryClient } from "@tanstack/react-query";
import { GEO_ROLE_LABELS, GEO_ROLES, type GeoRole } from "@workspace/geo-domain";
import { Checkbox } from "@workspace/ui/components/checkbox";
import { Skeleton } from "@workspace/ui/components/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@workspace/ui/components/table";
import { useState } from "react";
import { GeoStatusBadge } from "@/components/geo/shell/status-badge";
import { useGeoViewer } from "@/components/geo/shell/use-geo-viewer";
import { errorMessage } from "@/components/geo/tasks/labels";
import { changeGeoRoleFn } from "@/server/geo/admin";
import { ResultNotice } from "./notice";
import { geoAdminKeys, useGeoMembers } from "./queries";

const ASSIGNABLE: GeoRole[] = GEO_ROLES.filter((role) => role !== "viewer");

export function GeoMembersTab({ organizationId }: { organizationId: string }) {
	const viewer = useGeoViewer();
	const queryClient = useQueryClient();
	const { data, isLoading } = useGeoMembers(organizationId);
	const [pending, setPending] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const canManage = viewer.can("rbac.manage");

	async function toggle(userId: string, role: GeoRole, grant: boolean) {
		setPending(`${userId}:${role}`);
		setError(null);
		try {
			await changeGeoRoleFn({ data: { organizationId, input: { userId, role, grant } } });
			await queryClient.invalidateQueries({ queryKey: geoAdminKeys.members(organizationId) });
			// Role checks in the browser read this cached viewer; the server re-checks regardless.
			await queryClient.invalidateQueries({ queryKey: ["geo-viewer", organizationId] });
		} catch (err) {
			setError(errorMessage(err));
		} finally {
			setPending(null);
		}
	}

	if (isLoading) return <Skeleton className="h-64 w-full" />;

	return (
		<div className="flex flex-col gap-3">
			<p className="text-sm text-muted-foreground">
				组织所有者和管理员自动拥有平台管理员权限，但没有审核与发布权限；需要审核时请为自己分配审核角色，该操作会记入审计日志。未分配角色的成员为只读用户。每次角色变更都会记录审计。
			</p>
			<ResultNotice error={error} />
			<div className="overflow-x-auto rounded-lg border">
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>成员</TableHead>
							<TableHead>当前权限</TableHead>
							{ASSIGNABLE.map((role) => (
								<TableHead key={role} className="text-center">
									{GEO_ROLE_LABELS[role]}
								</TableHead>
							))}
							<TableHead>两步验证</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{(data ?? []).map((member) => (
							<TableRow key={member.userId}>
								<TableCell>
									<div className="font-medium">{member.name}</div>
									<div className="text-xs text-muted-foreground">{member.email}</div>
								</TableCell>
								<TableCell>
									<div className="flex flex-wrap gap-1">
										{member.effective.map((role) => (
											<GeoStatusBadge key={role} label={GEO_ROLE_LABELS[role]} />
										))}
									</div>
									{member.implicitAdmin && <div className="mt-1 text-xs text-muted-foreground">组织管理员</div>}
								</TableCell>
								{ASSIGNABLE.map((role) => (
									<TableCell key={role} className="text-center">
										<Checkbox
											aria-label={`${member.name} ${GEO_ROLE_LABELS[role]}`}
											checked={member.assigned.includes(role)}
											disabled={!canManage || pending !== null}
											onCheckedChange={(value) => toggle(member.userId, role, value === true)}
										/>
									</TableCell>
								))}
								<TableCell>
									<GeoStatusBadge
										label={member.twoFactorEnabled ? "已启用" : "未启用"}
										tone={member.twoFactorEnabled ? "success" : "neutral"}
									/>
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			</div>
		</div>
	);
}
