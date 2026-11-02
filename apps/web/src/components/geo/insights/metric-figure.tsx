import { Link } from "@tanstack/react-router";
import type { GeoPlatform, GeoSurfaceMode } from "@workspace/geo-domain";
import type { MetricValue } from "@workspace/geo-reports";
import { Tooltip, TooltipContent, TooltipTrigger } from "@workspace/ui/components/tooltip";
import { cn } from "@workspace/ui/lib/utils";
import type { ReactNode } from "react";
import { useGeoOrganization } from "@/components/geo/sampling/use-geo-organization";
import { GeoStatusBadge } from "@/components/geo/shell/status-badge";

export function percent(value: MetricValue): string {
	if (value.status === "NO_DATA") return "数据不足";
	return `${(value.rate * 100).toFixed(1)}%`;
}

export function fraction(value: MetricValue): string {
	return value.status === "OK" ? `${value.numerator}/${value.denominator}` : "—";
}

/**
 * A rate as it must be read: with its counts, a clear "低样本" mark, and "数据不足" (never
 * 0%) when nothing valid was sampled. `notProvided` is for citations nobody supplied.
 */
export function MetricFigure({
	value,
	notProvided,
	size = "default",
}: {
	value: MetricValue;
	notProvided?: boolean;
	size?: "default" | "lg";
}) {
	if (notProvided) {
		return <span className={cn("text-muted-foreground", size === "lg" && "text-2xl font-semibold")}>不提供</span>;
	}
	if (value.status === "NO_DATA") {
		return (
			<Tooltip>
				<TooltipTrigger
					render={
						<span className={cn("cursor-help text-muted-foreground", size === "lg" && "text-2xl font-semibold")}>
							数据不足
						</span>
					}
				/>
				<TooltipContent className="max-w-xs text-sm">{value.reason}</TooltipContent>
			</Tooltip>
		);
	}
	return (
		<span className="inline-flex flex-wrap items-baseline gap-1.5">
			<span className={cn("tabular-nums", size === "lg" ? "text-2xl font-semibold" : "font-medium")}>
				{percent(value)}
			</span>
			<span className="text-xs tabular-nums text-muted-foreground">{fraction(value)}</span>
			{value.lowSample && <GeoStatusBadge label="低样本" tone="warning" />}
		</span>
	);
}

export interface EvidenceFilter {
	platform?: GeoPlatform;
	surfaceMode?: GeoSurfaceMode;
	promptSetId?: string | null;
	promptId?: string;
	from: string;
	to: string;
}

/** Links a number to the valid samples it was computed from, in the evidence list. */
export function EvidenceLink({
	filter,
	children,
	className,
}: {
	filter: EvidenceFilter;
	children: ReactNode;
	className?: string;
}) {
	const organization = useGeoOrganization();
	return (
		<Link
			to="/app/org/$org/geo/observations"
			params={{ org: organization.slug }}
			search={{
				platform: filter.platform,
				surfaceMode: filter.surfaceMode,
				promptSetId: filter.promptSetId ?? undefined,
				promptId: filter.promptId,
				status: "VALID",
				from: filter.from,
				to: filter.to,
			}}
			className={cn("hover:underline", className)}
		>
			{children}
		</Link>
	);
}
