import type { ReactNode } from "react";
import { FilterSection, PageHeader } from "@/components/page-header";

export function GeoPageFrame({
	title,
	description,
	actions,
	filters,
	children,
}: {
	title: string;
	description: string;
	actions?: ReactNode;
	filters?: ReactNode;
	children: ReactNode;
}) {
	return (
		<div className="flex flex-1 flex-col gap-4">
			<div className="flex flex-wrap items-start justify-between gap-4">
				<PageHeader title={title} subtitle={description} />
				{actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
			</div>
			{filters && <FilterSection>{filters}</FilterSection>}
			{children}
		</div>
	);
}
