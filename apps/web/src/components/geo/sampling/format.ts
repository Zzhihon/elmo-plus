const DATE_TIME = new Intl.DateTimeFormat("zh-CN", {
	year: "numeric",
	month: "2-digit",
	day: "2-digit",
	hour: "2-digit",
	minute: "2-digit",
	hour12: false,
	timeZone: "Asia/Shanghai",
});

export function formatDateTime(value: string | null | undefined): string {
	return value ? DATE_TIME.format(new Date(value)) : "—";
}

export function formatDuration(ms: number | null | undefined): string {
	if (ms === null || ms === undefined) return "—";
	return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export function formatCost(value: number | null | undefined): string {
	return value === null || value === undefined ? "—" : value.toLocaleString("zh-CN", { maximumFractionDigits: 4 });
}

export function formatRate(numerator: number, denominator: number): string {
	return denominator > 0 ? `${Math.round((numerator / denominator) * 100)}%` : "—";
}
