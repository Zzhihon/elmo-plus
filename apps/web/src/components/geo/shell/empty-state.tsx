import type { ReactNode } from "react";

export function GeoEmptyState({
	title = "暂无数据",
	description,
	action,
}: {
	title?: string;
	description?: string;
	action?: ReactNode;
}) {
	return (
		<div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed p-10 text-center">
			<p className="text-sm font-medium">{title}</p>
			{description && <p className="max-w-md text-sm text-muted-foreground">{description}</p>}
			{action && <div className="mt-2">{action}</div>}
		</div>
	);
}
