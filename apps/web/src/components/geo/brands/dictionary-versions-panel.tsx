import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@workspace/ui/components/skeleton";
import { useState } from "react";
import { GeoPaginatedTable } from "@/components/geo/shell/paginated-table";
import { listGeoDictionaryVersionsFn } from "@/server/geo/profile";
import type { GeoDictionaryVersionSummary } from "@/server/geo/profile-core";
import { formatGeoDateTime, geoActorLabel } from "./format";

function summarize(version: GeoDictionaryVersionSummary): string {
	const parts = version.changes.map((change) => {
		const aliasNotes = [
			change.addedAliases.length > 0 && `+${change.addedAliases.length} 别名`,
			change.removedAliases.length > 0 && `-${change.removedAliases.length} 别名`,
		].filter(Boolean);
		return aliasNotes.length > 0 ? `${change.displayName}（${aliasNotes.join("，")}）` : change.displayName;
	});
	return parts.join("；") || "—";
}

export function DictionaryVersionsPanel({
	organizationId,
	members,
}: {
	organizationId: string;
	members: ReadonlyMap<string, string>;
}) {
	const [page, setPage] = useState(1);
	const { data, isLoading } = useQuery({
		queryKey: ["geo-dictionary-versions", organizationId, page],
		queryFn: () => listGeoDictionaryVersionsFn({ data: { organizationId, page } }),
	});
	if (isLoading || !data) return <Skeleton className="h-40 w-full" />;

	return (
		<GeoPaginatedTable
			rows={data.rows}
			rowKey={(row) => row.id}
			page={data.page}
			totalPages={data.totalPages}
			total={data.total}
			onPageChange={setPage}
			columns={[
				{ key: "version", header: "版本", cell: (row) => <span className="font-medium">v{row.version}</span> },
				{ key: "note", header: "变更说明", cell: (row) => row.changeNote ?? "—" },
				{ key: "entities", header: "涉及对象", cell: summarize, className: "max-w-md whitespace-normal" },
				{ key: "actor", header: "操作人", cell: (row) => geoActorLabel(row.createdBy, members) },
				{ key: "time", header: "时间", cell: (row) => formatGeoDateTime(row.createdAt) },
			]}
		/>
	);
}
