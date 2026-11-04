import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_authed/app/org/$org/geo/")({
	beforeLoad: ({ params }) => {
		throw redirect({ to: "/app/org/$org/geo/dashboard", params: { org: params.org }, replace: true });
	},
});
