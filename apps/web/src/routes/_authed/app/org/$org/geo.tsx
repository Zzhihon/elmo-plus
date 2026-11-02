import { createFileRoute, notFound, Outlet } from "@tanstack/react-router";
import { getGeoViewerFn } from "@/server/geo/viewer";

const VIEWER_STALE_MS = 60_000;

export const Route = createFileRoute("/_authed/app/org/$org/geo")({
	staticData: { shell: "geo", crumb: "GEO 工作台" },
	beforeLoad: async ({ context }) => {
		if (!context.clientConfig?.geoWorkspaceEnabled) throw notFound();
		const organizationId = context.organization.id;
		const geoViewer = await context.queryClient.ensureQueryData({
			queryKey: ["geo-viewer", organizationId],
			queryFn: () => getGeoViewerFn({ data: { organizationId } }),
			staleTime: VIEWER_STALE_MS,
		});
		return { geoViewer };
	},
	component: () => <Outlet />,
});
