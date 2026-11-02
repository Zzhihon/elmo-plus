import { createFileRoute, useRouteContext } from "@tanstack/react-router";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@workspace/ui/components/tabs";
import { GeoPageFrame } from "@/components/geo/shell/page-frame";
import { CreateManualTaskButton } from "@/components/geo/tasks/create-task-from-evidence";
import { GeoTaskBoard } from "@/components/geo/tasks/task-board";
import { GeoTaskList } from "@/components/geo/tasks/task-list";
import { pageHead } from "@/lib/route-head";

interface TasksSearch {
	view?: "board" | "list";
}

export const Route = createFileRoute("/_authed/app/org/$org/geo/tasks/")({
	staticData: { crumb: "优化工单" },
	head: pageHead({ description: "看板、责任人、审批、发布凭证与复测。" }),
	validateSearch: (search: Record<string, unknown>): TasksSearch => ({
		view: search.view === "list" ? "list" : undefined,
	}),
	component: GeoTasksPage,
});

function GeoTasksPage() {
	const { organization } = useRouteContext({ from: "/_authed/app/org/$org/geo" });
	const { view } = Route.useSearch();
	const navigate = Route.useNavigate();

	return (
		<GeoPageFrame
			title="优化工单"
			description="看板、责任人、审批、发布凭证与复测。已发布的工单要复测并确认后才算有效。"
			actions={<CreateManualTaskButton />}
		>
			<Tabs
				value={view ?? "board"}
				onValueChange={(value) => navigate({ search: { view: value === "list" ? "list" : undefined }, replace: true })}
			>
				<TabsList>
					<TabsTrigger value="board">看板</TabsTrigger>
					<TabsTrigger value="list">列表</TabsTrigger>
				</TabsList>
				<TabsContent value="board" className="mt-3">
					<GeoTaskBoard organizationId={organization.id} orgSlug={organization.slug} />
				</TabsContent>
				<TabsContent value="list" className="mt-3">
					<GeoTaskList organizationId={organization.id} orgSlug={organization.slug} />
				</TabsContent>
			</Tabs>
		</GeoPageFrame>
	);
}
