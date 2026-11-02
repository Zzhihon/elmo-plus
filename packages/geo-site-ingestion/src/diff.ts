export type DiffLine = { op: "same" | "added" | "removed"; text: string };

const MAX_LINES = 4000;

/** Line diff by longest common subsequence; long inputs are cut so the table stays bounded. */
export function diffLines(before: string, after: string): { lines: DiffLine[]; truncated: boolean } {
	const a = before.split("\n");
	const b = after.split("\n");
	const truncated = a.length > MAX_LINES || b.length > MAX_LINES;
	const left = a.slice(0, MAX_LINES);
	const right = b.slice(0, MAX_LINES);
	const rows = left.length + 1;
	const cols = right.length + 1;
	const table = new Uint32Array(rows * cols);
	for (let i = left.length - 1; i >= 0; i--) {
		for (let j = right.length - 1; j >= 0; j--) {
			table[i * cols + j] =
				left[i] === right[j]
					? table[(i + 1) * cols + j + 1] + 1
					: Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1]);
		}
	}
	const lines: DiffLine[] = [];
	let i = 0;
	let j = 0;
	while (i < left.length && j < right.length) {
		if (left[i] === right[j]) {
			lines.push({ op: "same", text: left[i] });
			i++;
			j++;
		} else if (table[(i + 1) * cols + j] >= table[i * cols + j + 1]) {
			lines.push({ op: "removed", text: left[i++] });
		} else {
			lines.push({ op: "added", text: right[j++] });
		}
	}
	while (i < left.length) lines.push({ op: "removed", text: left[i++] });
	while (j < right.length) lines.push({ op: "added", text: right[j++] });
	return { lines, truncated };
}
