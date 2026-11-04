import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@workspace/ui/components/tabs";
import { z } from "zod";
import { LivePanel } from "@/components/geo/console/live-panel";
import { ReplayPanel, type ReplaySelection } from "@/components/geo/console/replay-panel";
import { GeoPageFrame } from "@/components/geo/shell/page-frame";
import { useGeoViewer } from "@/components/geo/shell/use-geo-viewer";
import { pageHead } from "@/lib/route-head";

const consoleSearchSchema = z.object({
	mode: z.enum(["replay", "live"]).optional().catch(undefined),
	promptId: z.guid().optional().catch(undefined),
	observationId: z.guid().optional().catch(undefined),
	compare: z.boolean().optional().catch(undefined),
});

export const Route = createFileRoute("/_authed/app/org/$org/geo/console")({
	staticData: { crumb: "AI 对话模拟" },
	validateSearch: consoleSearchSchema,
	head: pageHead({ description: "看采购方向 AI 提问时，你的品牌怎样出现在回答里。" }),
	component: GeoConsolePage,
});

function GeoConsolePage() {
	const search = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const viewer = useGeoViewer();
	const mode = search.mode ?? "replay";

	const selectReplay = (next: ReplaySelection) =>
		navigate({
			search: {
				promptId: next.promptId,
				observationId: next.observationId,
				compare: next.compare || undefined,
			},
			replace: true,
		});

	return (
		<GeoPageFrame
			title="AI 对话模拟"
			description="看采购方向 AI 提问时，你的品牌怎样出现在回答里：绿色是你的品牌，橙色是竞品。"
		>
			<Tabs
				value={mode}
				onValueChange={(value) => navigate({ search: { ...search, mode: value === "live" ? "live" : undefined } })}
			>
				<TabsList>
					<TabsTrigger value="replay">回放真实回答</TabsTrigger>
					<TabsTrigger value="live">实时提问</TabsTrigger>
				</TabsList>
				<TabsContent value="replay" className="pt-4">
					<ReplayPanel organizationId={viewer.organizationId} selection={search} onChange={selectReplay} />
				</TabsContent>
				<TabsContent value="live" className="pt-4">
					<LivePanel organizationId={viewer.organizationId} canAsk={viewer.can("console.simulate")} />
				</TabsContent>
			</Tabs>
		</GeoPageFrame>
	);
}
