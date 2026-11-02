import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_authed/app/org/$org/geo/")({
	beforeLoad: ({ params }) => {
		throw redirect({ to: "/app/org/$org/geo/overview", params: { org: params.org }, replace: true });
	},
});
