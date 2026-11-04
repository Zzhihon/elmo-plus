import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireGeoServerFnPrincipal } from "./context";
import {
	dashboardLayoutSchema,
	getDashboard,
	getDashboardLayout,
	getSiteCompleteness,
	listTopImprovements,
	resetDashboardLayout,
	saveDashboardLayout,
} from "./dashboard-core";

const org = z.object({ organizationId: z.string() });

export const getDashboardFn = createServerFn({ method: "GET" })
	.validator(org)
	.handler(async ({ data }) => getDashboard(await requireGeoServerFnPrincipal(data.organizationId, "dashboard.read")));

export const listTopImprovementsFn = createServerFn({ method: "GET" })
	.validator(org)
	.handler(async ({ data }) =>
		listTopImprovements(await requireGeoServerFnPrincipal(data.organizationId, "recommendation.read")),
	);

export const getSiteCompletenessFn = createServerFn({ method: "GET" })
	.validator(org)
	.handler(async ({ data }) =>
		getSiteCompleteness(await requireGeoServerFnPrincipal(data.organizationId, "dashboard.read")),
	);

export const getDashboardLayoutFn = createServerFn({ method: "GET" })
	.validator(org)
	.handler(async ({ data }) =>
		getDashboardLayout(await requireGeoServerFnPrincipal(data.organizationId, "dashboard.read")),
	);

export const saveDashboardLayoutFn = createServerFn({ method: "POST" })
	.validator(org.merge(dashboardLayoutSchema))
	.handler(async ({ data }) =>
		saveDashboardLayout(await requireGeoServerFnPrincipal(data.organizationId, "dashboard.customize"), data),
	);

export const resetDashboardLayoutFn = createServerFn({ method: "POST" })
	.validator(org)
	.handler(async ({ data }) =>
		resetDashboardLayout(await requireGeoServerFnPrincipal(data.organizationId, "dashboard.customize")),
	);
