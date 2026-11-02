import { useRouteContext } from "@tanstack/react-router";

export function useGeoOrganization(): { id: string; slug: string } {
	const { organization } = useRouteContext({ from: "/_authed/app/org/$org/geo" });
	return { id: organization.id, slug: organization.slug };
}
