const CHINA_OFFSET_MS = 8 * 3_600_000;

export interface ReportPeriod {
	start: Date;
	/** Exclusive. */
	end: Date;
	label: string;
}

/** A calendar month in China time, the zone the people reading the report count months in. */
export function chinaMonth(year: number, month: number): ReportPeriod {
	const start = new Date(Date.UTC(year, month - 1, 1) - CHINA_OFFSET_MS);
	const end = new Date(Date.UTC(year, month, 1) - CHINA_OFFSET_MS);
	return { start, end, label: `${year} 年 ${month} 月` };
}

/** The last full China-time month before `now`. */
export function previousChinaMonth(now: Date): ReportPeriod {
	const local = new Date(now.getTime() + CHINA_OFFSET_MS);
	const year = local.getUTCFullYear();
	const month = local.getUTCMonth() + 1;
	return month === 1 ? chinaMonth(year - 1, 12) : chinaMonth(year, month - 1);
}

/** China-time calendar days `from`..`to` inclusive, as a half-open instant range. */
export function chinaDayRange(from: string, to: string): ReportPeriod {
	const start = new Date(`${from}T00:00:00+08:00`);
	const end = new Date(new Date(`${to}T00:00:00+08:00`).getTime() + 86_400_000);
	return { start, end, label: from === to ? from : `${from} 至 ${to}` };
}

export function chinaDate(date: Date): string {
	return new Date(date.getTime() + CHINA_OFFSET_MS).toISOString().slice(0, 10);
}
