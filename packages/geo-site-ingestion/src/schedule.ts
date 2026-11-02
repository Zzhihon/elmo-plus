import type { SiteOpWindow } from "./profile";

/** Every 24 hours, early morning China time, as the PRD's starting default. */
export const DEFAULT_CRAWL_CRON = "0 3 * * *";
export const DEFAULT_TIMEZONE = "Asia/Shanghai";

interface CronField {
	values: Set<number>;
	any: boolean;
}

const RANGES: Array<[number, number]> = [
	[0, 59],
	[0, 23],
	[1, 31],
	[1, 12],
	[0, 7],
];

function rangeOf(range: string, hasStep: boolean, [min, max]: [number, number]): [number, number] {
	if (range === "*") return [min, max];
	if (range.includes("-")) {
		const [from, to] = range.split("-").map(Number);
		return [from, to];
	}
	const from = Number(range);
	return [from, hasStep ? max : from];
}

function parseField(spec: string, bounds: [number, number]): CronField {
	if (spec === "*") return { values: new Set(), any: true };
	const values = new Set<number>();
	for (const part of spec.split(",")) {
		const [range, stepText] = part.split("/");
		const step = stepText === undefined ? 1 : Number(stepText);
		if (!Number.isInteger(step) || step < 1) throw new Error(`无效的步长：${part}`);
		const [from, to] = rangeOf(range, stepText !== undefined, bounds);
		if (!Number.isInteger(from) || !Number.isInteger(to) || from < bounds[0] || to > bounds[1] || from > to) {
			throw new Error(`超出范围：${part}`);
		}
		for (let value = from; value <= to; value += step) values.add(value);
	}
	return { values, any: false };
}

export interface CronExpression {
	minute: CronField;
	hour: CronField;
	day: CronField;
	month: CronField;
	weekday: CronField;
}

/** Standard five-field cron: minute hour day-of-month month day-of-week. */
export function parseCron(expression: string): CronExpression {
	const parts = expression.trim().split(/\s+/);
	if (parts.length !== 5) throw new Error("cron 表达式必须是 5 段");
	const [minute, hour, day, month, weekday] = parts.map((part, index) => parseField(part, RANGES[index]));
	if (weekday.values.has(7)) weekday.values.add(0);
	return { minute, hour, day, month, weekday };
}

export function isValidCron(expression: string): boolean {
	try {
		parseCron(expression);
		return true;
	} catch {
		return false;
	}
}

interface LocalTime {
	minute: number;
	hour: number;
	day: number;
	month: number;
	weekday: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function localTime(date: Date, timezone: string): LocalTime {
	let formatter = formatters.get(timezone);
	if (!formatter) {
		formatter = new Intl.DateTimeFormat("en-US", {
			timeZone: timezone,
			hourCycle: "h23",
			minute: "numeric",
			hour: "numeric",
			day: "numeric",
			month: "numeric",
			weekday: "short",
		});
		formatters.set(timezone, formatter);
	}
	const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
	const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
	return {
		minute: Number(parts.minute),
		hour: Number(parts.hour),
		day: Number(parts.day),
		month: Number(parts.month),
		weekday: weekdays.indexOf(parts.weekday),
	};
}

function matches(cron: CronExpression, time: LocalTime): boolean {
	const hit = (field: CronField, value: number) => field.any || field.values.has(value);
	const dayMatches =
		cron.day.any || cron.weekday.any
			? hit(cron.day, time.day) && hit(cron.weekday, time.weekday)
			: hit(cron.day, time.day) || hit(cron.weekday, time.weekday);
	return hit(cron.minute, time.minute) && hit(cron.hour, time.hour) && hit(cron.month, time.month) && dayMatches;
}

/** The latest minute in `(after, until]` at which the expression fires, or null. Looks back at most two days. */
export function lastCronFireBetween(expression: string, after: Date, until: Date, timezone: string): Date | null {
	const cron = parseCron(expression);
	const floor = Math.max(after.getTime(), until.getTime() - 2 * 24 * 60 * 60 * 1000);
	const start = Math.floor(until.getTime() / 60_000) * 60_000;
	for (let at = start; at > floor; at -= 60_000) {
		if (matches(cron, localTime(new Date(at), timezone))) return new Date(at);
	}
	return null;
}

function minutesOf(value: string): number {
	const [hours, minutes] = value.split(":").map(Number);
	return hours * 60 + minutes;
}

function isoWeekday(weekday: number): number {
	return weekday === 0 ? 7 : weekday;
}

export function isWithinWindow(window: SiteOpWindow | null, at: Date): boolean {
	if (!window) return true;
	const time = localTime(at, window.timezone);
	if (window.days.length > 0 && !window.days.includes(isoWeekday(time.weekday))) return false;
	const now = time.hour * 60 + time.minute;
	const start = minutesOf(window.start);
	const end = minutesOf(window.end);
	return start <= end ? now >= start && now < end : now >= start || now < end;
}

/** The next moment the window opens, searched minute by minute over the coming week. */
export function nextWindowStart(window: SiteOpWindow, from: Date): Date {
	const start = Math.ceil(from.getTime() / 60_000) * 60_000;
	for (let at = start; at < start + 8 * 24 * 60 * 60_000; at += 60_000) {
		if (isWithinWindow(window, new Date(at))) return new Date(at);
	}
	return new Date(start + 24 * 60 * 60_000);
}
