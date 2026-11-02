import { neutralizeCsvCell } from "@workspace/geo-domain";

function quote(value: string): string {
	return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * UTF-8 with a BOM so spreadsheets read the Chinese correctly, and every cell that a
 * spreadsheet would evaluate as a formula (including full-width `＝`) is prefixed with
 * a quote, so a domain or answer excerpt can never run as one.
 */
export function toCsv(rows: readonly (readonly (string | number | null | undefined)[])[]): string {
	const lines = rows.map((row) =>
		row.map((cell) => quote(neutralizeCsvCell(cell === null || cell === undefined ? "" : String(cell)))).join(","),
	);
	return `﻿${lines.join("\r\n")}\r\n`;
}
