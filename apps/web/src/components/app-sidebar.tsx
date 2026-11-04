import {
	IconBriefcase,
	IconBuilding,
	IconBuildings,
	IconChartBar,
	IconChecklist,
	IconCode,
	IconCpu,
	IconCreditCard,
	IconDashboard,
	IconDatabaseSearch,
	IconFileAnalytics,
	IconFileSearch,
	IconKey,
	IconLink,
	IconListDetails,
	IconMessages,
	IconMoodSmile,
	IconPlugConnected,
	IconRadar,
	IconSchool,
	IconSettings,
	IconShieldCheck,
	IconSitemap,
	IconSpeakerphone,
	IconTarget,
	IconUsers,
	IconWorld,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { DeploymentMode, FeaturesConfig } from "@workspace/config/types";
import { brandLinkParams, orgLinkParams } from "@workspace/lib/app-urls";
import type { BrandWithPrompts } from "@workspace/lib/db/schema";

import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarHeader,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	useSidebar,
} from "@workspace/ui/components/sidebar";
import { DemoModePill } from "@/components/demo-mode-pill";
import { Logo } from "@/components/logo";
import { NavAppInfo } from "@/components/nav-app-info";
import { type NavGroup, type NavItem, NavMain } from "@/components/nav-main";
import { NavUser } from "@/components/nav-user";
import { useDeploymentFeatures } from "@/hooks/use-deployment-features";
import { useLooseRouteContext, useViewer } from "@/hooks/use-route-context";
import { adminNavItems } from "@/lib/admin-nav";
import type { OrganizationSummary } from "@/lib/organizations/types";
import type { ShellScope } from "@/lib/shell-scope";
import { getGeoViewerFn } from "@/server/geo/viewer";

export type AppSidebarProps = ShellScope;

function organizationGroups(
	organization: OrganizationSummary,
	features?: FeaturesConfig,
	mode?: DeploymentMode,
): NavGroup[] {
	const params = orgLinkParams(organization);
	const items: NavItem[] = [
		{ title: "Organization", link: { to: "/app/org/$org/settings", params }, icon: IconBriefcase, exact: true },
		{ title: "Brands", link: { to: "/app/org/$org/settings/brands", params }, icon: IconBuildings },
	];

	if (features?.teamInvites) {
		items.push({ title: "Team", link: { to: "/app/org/$org/settings/members", params }, icon: IconUsers });
	}

	if (features?.billing) {
		items.push({ title: "Billing", link: { to: "/app/org/$org/settings/billing", params }, icon: IconCreditCard });
	}

	items.push({ title: "API Keys", link: { to: "/app/org/$org/settings/api-keys", params }, icon: IconKey });

	const docs: NavItem[] = [
		{ title: "API", link: { to: "/app/org/$org/settings/api", params }, icon: IconCode },
		{ title: "MCP", link: { to: "/app/org/$org/settings/mcp", params }, icon: IconPlugConnected },
	];

	// The skill is Elmo's, and whitelabel deployments never point users at Elmo.
	if (mode !== "whitelabel") {
		docs.push({ title: "Skill", link: { to: "/app/org/$org/settings/skill", params }, icon: IconSchool });
	}

	return [
		{ label: "Organization Settings", items },
		{ label: "Docs", items: docs },
	];
}

function brandGroups(organization: OrganizationSummary, brand: BrandWithPrompts): NavGroup[] {
	const params = brandLinkParams(organization, brand);
	const dashboard: NavItem[] = [
		{ title: "Overview", link: { to: "/app/org/$org/brand/$brand", params }, icon: IconDashboard, exact: true },
	];

	if (brand.onboarded) {
		dashboard.push(
			{ title: "Visibility", link: { to: "/app/org/$org/brand/$brand/visibility", params }, icon: IconChartBar },
			{
				title: "Share of Voice",
				link: { to: "/app/org/$org/brand/$brand/share-of-voice", params },
				icon: IconSpeakerphone,
			},
			{ title: "Sentiment", link: { to: "/app/org/$org/brand/$brand/sentiment", params }, icon: IconMoodSmile },
			{ title: "Responses", link: { to: "/app/org/$org/brand/$brand/responses", params }, icon: IconMessages },
			{ title: "Query Fan-Out", link: { to: "/app/org/$org/brand/$brand/query-fan-out", params }, icon: IconSitemap },
			{ title: "Citations", link: { to: "/app/org/$org/brand/$brand/citations", params }, icon: IconLink },
			{ title: "Opportunities", link: { to: "/app/org/$org/brand/$brand/opportunities", params }, icon: IconTarget },
		);
	}

	const groups: NavGroup[] = [{ label: "Dashboard", items: dashboard }];

	if (brand.onboarded) {
		groups.push({
			label: "Settings",
			items: [
				{ title: "Brand", link: { to: "/app/org/$org/brand/$brand/settings/brand", params }, icon: IconBuilding },
				{
					title: "Competitors",
					link: { to: "/app/org/$org/brand/$brand/settings/competitors", params },
					icon: IconBuildings,
				},
				{
					title: "Prompts",
					link: { to: "/app/org/$org/brand/$brand/settings/prompts", params },
					icon: IconListDetails,
				},
				{ title: "LLMs", link: { to: "/app/org/$org/brand/$brand/settings/llms", params }, icon: IconCpu },
			],
		});
	}

	return groups;
}

const GEO_GROUP_LABEL = "GEO 工作台";

function geoGroup(organization: OrganizationSummary): NavGroup {
	const params = orgLinkParams(organization);
	return {
		label: GEO_GROUP_LABEL,
		items: [
			{ title: "曝光看板", link: { to: "/app/org/$org/geo/dashboard", params }, icon: IconDashboard },
			{ title: "AI 对话模拟", link: { to: "/app/org/$org/geo/console", params }, icon: IconMessages },
			{ title: "提升建议", link: { to: "/app/org/$org/geo/recommendations", params }, icon: IconTarget },
			{ title: "监测问题与竞品", link: { to: "/app/org/$org/geo/setup", params }, icon: IconListDetails },
			{ title: "报告", link: { to: "/app/org/$org/geo/reports", params }, icon: IconFileAnalytics },
		],
	};
}

function geoOperationsGroup(organization: OrganizationSummary): NavGroup {
	const params = orgLinkParams(organization);
	return {
		label: "运营后台",
		items: [
			{ title: "总览", link: { to: "/app/org/$org/geo/overview", params }, icon: IconChartBar },
			{ title: "品牌与竞品", link: { to: "/app/org/$org/geo/brands", params }, icon: IconBuildings },
			{ title: "问法库", link: { to: "/app/org/$org/geo/questions", params }, icon: IconListDetails },
			{ title: "采样中心", link: { to: "/app/org/$org/geo/sampling", params }, icon: IconRadar },
			{ title: "证据库", link: { to: "/app/org/$org/geo/observations", params }, icon: IconFileSearch },
			{ title: "诊断分析", link: { to: "/app/org/$org/geo/insights", params }, icon: IconChartBar },
			{ title: "可信知识", link: { to: "/app/org/$org/geo/knowledge", params }, icon: IconShieldCheck },
			{ title: "优化工单", link: { to: "/app/org/$org/geo/tasks", params }, icon: IconChecklist },
			{ title: "官网来源", link: { to: "/app/org/$org/geo/sources", params }, icon: IconWorld },
			{ title: "官网页面", link: { to: "/app/org/$org/geo/site-pages", params }, icon: IconDatabaseSearch },
			{ title: "站点审计", link: { to: "/app/org/$org/geo/site-audit", params }, icon: IconSitemap },
			{ title: "工作台设置", link: { to: "/app/org/$org/geo/settings", params }, icon: IconSettings },
		],
	};
}

/** The way in from the rest of the app, without the whole workspace's navigation beside a brand's. */
function geoEntryGroup(organization: OrganizationSummary): NavGroup {
	return {
		label: GEO_GROUP_LABEL,
		items: [
			{
				title: "进入工作台",
				link: { to: "/app/org/$org/geo/dashboard", params: orgLinkParams(organization) },
				icon: IconRadar,
			},
		],
	};
}

function geoGroups(section: ShellScope["section"], organization: OrganizationSummary, staff: boolean): NavGroup[] {
	if (section === "geo")
		return staff ? [geoGroup(organization), geoOperationsGroup(organization)] : [geoGroup(organization)];
	if (section === "brand" || section === "organization") return [geoEntryGroup(organization)];
	return [];
}

function sectionGroups(
	{ section, organization, brand }: ShellScope,
	features?: FeaturesConfig,
	mode?: DeploymentMode,
): NavGroup[] {
	if (section === "brand" && organization && brand) return brandGroups(organization, brand);
	if (section === "organization" && organization) return organizationGroups(organization, features, mode);
	return [];
}

export function AppSidebar({ section, organization, brand }: AppSidebarProps) {
	const { setOpenMobile } = useSidebar();
	const { isAdmin, hasReportAccess } = useViewer();
	const features = useDeploymentFeatures();
	const { clientConfig } = useLooseRouteContext();
	const mode = clientConfig?.mode;
	const geoEnabled = clientConfig?.geoWorkspaceEnabled ?? false;
	const geoViewer = useQuery({
		queryKey: ["geo-viewer", organization?.id],
		queryFn: () => getGeoViewerFn({ data: { organizationId: organization?.id ?? "" } }),
		enabled: Boolean(organization) && geoEnabled && section === "geo",
		staleTime: 60_000,
	});
	const geoStaff = geoViewer.data?.roles.some((role) => role !== "viewer") ?? false;
	// Reports are disabled entirely in cloud; hide the nav entry there.
	const reportsEnabled = features?.reportGeneration ?? true;

	// A gate page offers no destinations: every link would either 404 or bounce
	// the user straight back to the gate.
	const adminItems = section === "account" ? [] : adminNavItems({ isAdmin, hasReportAccess, reportsEnabled });

	const groups: NavGroup[] = [
		...sectionGroups({ section, organization, brand }, features, mode),
		...(organization && geoEnabled ? geoGroups(section, organization, geoStaff) : []),
		...(section === "admin" && adminItems.length > 0 ? [{ label: "Admin", items: adminItems }] : []),
	];
	const brandmark = (
		<>
			<Logo iconClassName="!size-5" />
			<div className="ml-auto group-data-[collapsible=icon]:hidden">
				<DemoModePill />
			</div>
		</>
	);

	return (
		<Sidebar variant="inset">
			<SidebarHeader>
				<SidebarMenu>
					<SidebarMenuItem>
						{/* On a gate page the mark still says whose product this is, but it
						    leads nowhere — /app would redirect right back here. */}
						{section === "account" ? (
							<div className="flex items-center gap-2 p-2">{brandmark}</div>
						) : (
							<SidebarMenuButton size="lg" render={<Link to="/app" onClick={() => setOpenMobile(false)} />}>
								{brandmark}
							</SidebarMenuButton>
						)}
					</SidebarMenuItem>
				</SidebarMenu>
			</SidebarHeader>
			<SidebarContent>
				<NavMain groups={groups} />
			</SidebarContent>
			<SidebarFooter>
				<NavUser showOrganizations={section !== "account"} adminItems={section === "admin" ? [] : adminItems} />
				<NavAppInfo />
			</SidebarFooter>
		</Sidebar>
	);
}
