import { createFileRoute, useRouteContext } from "@tanstack/react-router";
import { Alert, AlertDescription, AlertTitle } from "@workspace/ui/components/alert";
import { Skeleton } from "@workspace/ui/components/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@workspace/ui/components/tabs";
import { GeoApprovalsTab } from "@/components/geo/settings/approvals-tab";
import { GeoAuditTab } from "@/components/geo/settings/audit-tab";
import { GeoCredentialsTab } from "@/components/geo/settings/credentials-tab";
import { GeoLimitsTab } from "@/components/geo/settings/limits-tab";
import { GeoMembersTab } from "@/components/geo/settings/members-tab";
import { GeoOpsTab } from "@/components/geo/settings/ops-tab";
import { useGeoSecurity } from "@/components/geo/settings/queries";
import { GeoSecurityTab } from "@/components/geo/settings/security-tab";
import { GeoPageFrame } from "@/components/geo/shell/page-frame";
import { useGeoViewer } from "@/components/geo/shell/use-geo-viewer";
import { pageHead } from "@/lib/route-head";

const TABS = ["members", "approvals", "credentials", "limits", "audit", "ops", "security"] as const;
type Tab = (typeof TABS)[number];

interface SettingsSearch {
	tab?: Tab;
	entityId?: string;
}

export const Route = createFileRoute("/_authed/app/org/$org/geo/settings")({
	staticData: { crumb: "工作台设置" },
	head: pageHead({ description: "用户权限、平台密钥、采样限额与审计日志。" }),
	validateSearch: (search: Record<string, unknown>): SettingsSearch => ({
		tab: TABS.includes(search.tab as Tab) ? (search.tab as Tab) : undefined,
		entityId: typeof search.entityId === "string" ? search.entityId : undefined,
	}),
	component: GeoSettingsPage,
});

function GeoSettingsPage() {
	const { organization } = useRouteContext({ from: "/_authed/app/org/$org/geo" });
	const viewer = useGeoViewer();
	const { tab, entityId } = Route.useSearch();
	const navigate = Route.useNavigate();
	const security = useGeoSecurity(organization.id);
	const isAdmin = viewer.can("settings.read");
	const unlocked = isAdmin && security.data?.mfaSatisfied === true;
	const current: Tab = unlocked ? (tab ?? "members") : "security";

	return (
		<GeoPageFrame title="工作台设置" description="用户权限、平台密钥、采样限额、保留期、审计日志与运行状态。">
			{security.isLoading && <Skeleton className="h-64 w-full" />}
			{!isAdmin && (
				<Alert>
					<AlertTitle>需要平台管理员权限</AlertTitle>
					<AlertDescription>工作台设置只对平台管理员开放。你可以在这里设置自己的两步验证。</AlertDescription>
				</Alert>
			)}
			{isAdmin && security.data && !security.data.mfaSatisfied && (
				<Alert variant="destructive">
					<AlertTitle>请先完成两步验证</AlertTitle>
					<AlertDescription>本组织要求平台管理员在本次登录中完成两步验证后才能使用管理设置。</AlertDescription>
				</Alert>
			)}
			{security.data && (
				<Tabs value={current} onValueChange={(value) => navigate({ search: { tab: value as Tab }, replace: true })}>
					<TabsList className="flex-wrap">
						{unlocked && (
							<>
								<TabsTrigger value="members">成员与角色</TabsTrigger>
								<TabsTrigger value="approvals">审批</TabsTrigger>
								<TabsTrigger value="credentials">平台密钥</TabsTrigger>
								<TabsTrigger value="limits">限额、告警与保留期</TabsTrigger>
								<TabsTrigger value="audit">审计日志</TabsTrigger>
								<TabsTrigger value="ops">运行状态</TabsTrigger>
							</>
						)}
						<TabsTrigger value="security">安全</TabsTrigger>
					</TabsList>
					{unlocked && (
						<>
							<TabsContent value="members" className="mt-3">
								<GeoMembersTab organizationId={organization.id} />
							</TabsContent>
							<TabsContent value="approvals" className="mt-3">
								<GeoApprovalsTab organizationId={organization.id} />
							</TabsContent>
							<TabsContent value="credentials" className="mt-3">
								<GeoCredentialsTab organizationId={organization.id} />
							</TabsContent>
							<TabsContent value="limits" className="mt-3">
								<GeoLimitsTab organizationId={organization.id} />
							</TabsContent>
							<TabsContent value="audit" className="mt-3">
								<GeoAuditTab key={entityId} organizationId={organization.id} initialEntityId={entityId} />
							</TabsContent>
							<TabsContent value="ops" className="mt-3">
								<GeoOpsTab organizationId={organization.id} />
							</TabsContent>
						</>
					)}
					<TabsContent value="security" className="mt-3">
						<GeoSecurityTab organizationId={organization.id} />
					</TabsContent>
				</Tabs>
			)}
		</GeoPageFrame>
	);
}
