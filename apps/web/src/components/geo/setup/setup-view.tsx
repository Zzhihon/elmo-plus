import { Tabs, TabsContent, TabsList, TabsTrigger } from "@workspace/ui/components/tabs";
import { useState } from "react";
import { GeoPageFrame } from "@/components/geo/shell/page-frame";
import { CompetitorsPanel } from "./competitors-panel";
import { QuestionPicker } from "./question-picker";

export function GeoSetupView({ organizationId }: { organizationId: string }) {
	const [tab, setTab] = useState<string>("questions");
	return (
		<GeoPageFrame title="监测问题与竞品" description="挑选要让 AI 平台回答的买家问题，确认需要一起对比的竞品。">
			<Tabs value={tab} onValueChange={(value) => setTab(String(value))}>
				<TabsList>
					<TabsTrigger value="questions">监测问题</TabsTrigger>
					<TabsTrigger value="competitors">竞品</TabsTrigger>
				</TabsList>
				<TabsContent value="questions" className="pt-4">
					<QuestionPicker organizationId={organizationId} />
				</TabsContent>
				<TabsContent value="competitors" className="pt-4">
					<CompetitorsPanel organizationId={organizationId} />
				</TabsContent>
			</Tabs>
		</GeoPageFrame>
	);
}
