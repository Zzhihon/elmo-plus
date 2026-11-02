/** pg-boss names shared by the worker, which owns them, and the web app, which sends to them. */
export const GEO_QUEUE = {
	siteSchedule: "geo-site-schedule",
	siteCrawl: "geo-site-crawl",
	siteParse: "geo-site-parse",
	siteNormalize: "geo-site-normalize",
	siteAudit: "geo-site-audit",
	knowledgeScan: "geo-knowledge-scan",
	knowledgeImport: "geo-knowledge-import",
	draftGenerate: "geo-draft-generate",
	samplingDispatch: "geo-sampling-dispatch",
	samplingCapture: "geo-sampling-capture",
	evaluation: "geo-evaluation",
	reportGenerate: "geo-report-generate",
	taskRetest: "geo-task-retest",
	maintenance: "geo-maintenance",
} as const;

export type GeoQueueName = `geo-${string}`;

export function samplingRunIdempotencyKey(input: {
	batchId: string;
	promptId: string;
	targetId: string;
	repeatIndex: number;
	/** Set only for an explicit re-sample, which counts as a new run. */
	resampleOf?: string;
}): string {
	const base = `${input.batchId}:${input.promptId}:${input.targetId}:${input.repeatIndex}`;
	return input.resampleOf ? `${base}:resample:${input.resampleOf}` : base;
}
