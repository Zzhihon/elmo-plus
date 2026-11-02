import { createFileRoute } from "@tanstack/react-router";
import { GeoEmptyState } from "@/components/geo/shell/empty-state";
import { GeoPageFrame } from "@/components/geo/shell/page-frame";
import { pageHead } from "@/lib/route-head";

export const Route = createFileRoute("/_authed/app/org/$org/geo/settings")({
	staticData: { crumb: "工作台设置" },
	head: pageHead({ description: "用户权限、平台密钥、采样限额与审计日志。" }),
	component: GeoSettingsPage,
});

function GeoSettingsPage() {
	return (
		<GeoPageFrame title="工作台设置" description="用户权限、平台密钥、采样限额与审计日志。">
			<GeoEmptyState />
		</GeoPageFrame>
	);
}
