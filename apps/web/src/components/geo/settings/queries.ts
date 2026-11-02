import { useQuery } from "@tanstack/react-query";
import {
	getGeoOpsMetricsFn,
	getGeoSecurityFn,
	getGeoSettingsFn,
	listGeoAdminRequestsFn,
	listGeoAlertsFn,
	listGeoAuditLogsFn,
	listGeoCredentialsFn,
	listGeoMembersFn,
} from "@/server/geo/admin";
import type { AuditQuery } from "@/server/geo/admin-core";

export const geoAdminKeys = {
	all: (organizationId: string) => ["geo-admin", organizationId] as const,
	security: (organizationId: string) => ["geo-admin", organizationId, "security"] as const,
	settings: (organizationId: string) => ["geo-admin", organizationId, "settings"] as const,
	requests: (organizationId: string) => ["geo-admin", organizationId, "requests"] as const,
	members: (organizationId: string) => ["geo-admin", organizationId, "members"] as const,
	credentials: (organizationId: string) => ["geo-admin", organizationId, "credentials"] as const,
	audit: (organizationId: string, filters: AuditQuery, page: number) =>
		["geo-admin", organizationId, "audit", filters, page] as const,
	ops: (organizationId: string) => ["geo-admin", organizationId, "ops"] as const,
	alerts: (organizationId: string, includeResolved: boolean) =>
		["geo-admin", organizationId, "alerts", includeResolved] as const,
};

export const useGeoSecurity = (organizationId: string) =>
	useQuery({
		queryKey: geoAdminKeys.security(organizationId),
		queryFn: () => getGeoSecurityFn({ data: { organizationId } }),
	});

export const useGeoSettings = (organizationId: string) =>
	useQuery({
		queryKey: geoAdminKeys.settings(organizationId),
		queryFn: () => getGeoSettingsFn({ data: { organizationId } }),
	});

export const useGeoAdminRequests = (organizationId: string) =>
	useQuery({
		queryKey: geoAdminKeys.requests(organizationId),
		queryFn: () => listGeoAdminRequestsFn({ data: { organizationId } }),
	});

export const useGeoMembers = (organizationId: string) =>
	useQuery({
		queryKey: geoAdminKeys.members(organizationId),
		queryFn: () => listGeoMembersFn({ data: { organizationId } }),
	});

export const useGeoCredentials = (organizationId: string) =>
	useQuery({
		queryKey: geoAdminKeys.credentials(organizationId),
		queryFn: () => listGeoCredentialsFn({ data: { organizationId } }),
	});

export const useGeoAuditLogs = (organizationId: string, filters: AuditQuery, page: number) =>
	useQuery({
		queryKey: geoAdminKeys.audit(organizationId, filters, page),
		queryFn: () => listGeoAuditLogsFn({ data: { organizationId, filters, page, limit: 50 } }),
		placeholderData: (previous) => previous,
	});

export const useGeoOpsMetrics = (organizationId: string) =>
	useQuery({
		queryKey: geoAdminKeys.ops(organizationId),
		queryFn: () => getGeoOpsMetricsFn({ data: { organizationId } }),
		refetchInterval: 60_000,
	});

export const useGeoAlerts = (organizationId: string, includeResolved: boolean) =>
	useQuery({
		queryKey: geoAdminKeys.alerts(organizationId, includeResolved),
		queryFn: () => listGeoAlertsFn({ data: { organizationId, includeResolved } }),
	});
