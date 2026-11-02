import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireGeoServerFnPrincipal } from "./context";
import {
	crawlRunCreateSchema,
	createQaSample,
	createSite,
	getCrawlRun,
	getKeyUrlCoverage,
	getPageVersion,
	getQaSample,
	getSite,
	getSitePage,
	getSnapshotForViewing,
	labelQaItem,
	listCrawlRuns,
	listQaSamples,
	listSitePages,
	listSites,
	qaLabelSchema,
	refetchPage,
	reparseSchema,
	requestReparse,
	retryFailedUrls,
	setKeyUrls,
	setRunPaused,
	sitePageFilterSchema,
	siteSourcePatchSchema,
	startCrawl,
	updateSite,
} from "./site-core";

const org = z.object({ organizationId: z.string().min(1) });
const pagingSchema = z.object({ page: z.number().int().min(1).default(1), limit: z.number().int().min(1).max(100).default(20) });

function paging(input: { page: number; limit: number }) {
	return { page: input.page, limit: input.limit, offset: (input.page - 1) * input.limit };
}

export const listSitesFn = createServerFn({ method: "GET" })
	.validator(org)
	.handler(async ({ data }) => listSites(await requireGeoServerFnPrincipal(data.organizationId, "site.read")));

export const getSiteFn = createServerFn({ method: "GET" })
	.validator(org.extend({ siteId: z.string().uuid() }))
	.handler(async ({ data }) => getSite(await requireGeoServerFnPrincipal(data.organizationId, "site.read"), data.siteId));

export const createSiteFn = createServerFn({ method: "POST" })
	.validator(org.extend({ config: z.unknown() }))
	.handler(async ({ data }) =>
		createSite(await requireGeoServerFnPrincipal(data.organizationId, "site.manage"), data.config),
	);

export const updateSiteFn = createServerFn({ method: "POST" })
	.validator(org.extend({ siteId: z.string().uuid(), patch: siteSourcePatchSchema }))
	.handler(async ({ data }) =>
		updateSite(await requireGeoServerFnPrincipal(data.organizationId, "site.manage"), data.siteId, data.patch),
	);

export const startCrawlFn = createServerFn({ method: "POST" })
	.validator(org.extend({ siteId: z.string().uuid(), input: crawlRunCreateSchema }))
	.handler(async ({ data }) =>
		startCrawl(await requireGeoServerFnPrincipal(data.organizationId, "site.crawl"), data.siteId, data.input),
	);

export const listCrawlRunsFn = createServerFn({ method: "GET" })
	.validator(org.extend({ siteId: z.string().uuid() }).merge(pagingSchema))
	.handler(async ({ data }) =>
		listCrawlRuns(await requireGeoServerFnPrincipal(data.organizationId, "site.read"), data.siteId, paging(data)),
	);

export const getCrawlRunFn = createServerFn({ method: "GET" })
	.validator(org.extend({ siteId: z.string().uuid(), runId: z.string().uuid() }))
	.handler(async ({ data }) =>
		getCrawlRun(await requireGeoServerFnPrincipal(data.organizationId, "site.read"), data.siteId, data.runId),
	);

export const setCrawlRunPausedFn = createServerFn({ method: "POST" })
	.validator(org.extend({ siteId: z.string().uuid(), runId: z.string().uuid(), paused: z.boolean() }))
	.handler(async ({ data }) =>
		setRunPaused(
			await requireGeoServerFnPrincipal(data.organizationId, "site.crawl"),
			data.siteId,
			data.runId,
			data.paused,
		),
	);

export const retryFailedUrlsFn = createServerFn({ method: "POST" })
	.validator(org.extend({ siteId: z.string().uuid(), runId: z.string().uuid() }))
	.handler(async ({ data }) =>
		retryFailedUrls(await requireGeoServerFnPrincipal(data.organizationId, "site.crawl"), data.siteId, data.runId),
	);

export const listSitePagesFn = createServerFn({ method: "GET" })
	.validator(org.extend({ filters: sitePageFilterSchema }).merge(pagingSchema))
	.handler(async ({ data }) =>
		listSitePages(await requireGeoServerFnPrincipal(data.organizationId, "site.read"), data.filters, paging(data)),
	);

export const getSitePageFn = createServerFn({ method: "GET" })
	.validator(org.extend({ pageId: z.string().uuid() }))
	.handler(async ({ data }) =>
		getSitePage(await requireGeoServerFnPrincipal(data.organizationId, "site.read"), data.pageId),
	);

export const getPageVersionFn = createServerFn({ method: "GET" })
	.validator(
		org.extend({ pageId: z.string().uuid(), versionId: z.string().uuid(), compareTo: z.string().uuid().nullish() }),
	)
	.handler(async ({ data }) =>
		getPageVersion(
			await requireGeoServerFnPrincipal(data.organizationId, "site.read"),
			data.pageId,
			data.versionId,
			data.compareTo,
		),
	);

export const getSnapshotViewFn = createServerFn({ method: "GET" })
	.validator(org.extend({ versionId: z.string().uuid() }))
	.handler(async ({ data }) =>
		getSnapshotForViewing(
			await requireGeoServerFnPrincipal(data.organizationId, "site.read_snapshot"),
			data.versionId,
		),
	);

export const requestReparseFn = createServerFn({ method: "POST" })
	.validator(org.extend({ pageId: z.string().uuid(), input: reparseSchema }))
	.handler(async ({ data }) =>
		requestReparse(await requireGeoServerFnPrincipal(data.organizationId, "site.reparse"), data.pageId, data.input),
	);

export const refetchPageFn = createServerFn({ method: "POST" })
	.validator(org.extend({ pageId: z.string().uuid() }))
	.handler(async ({ data }) =>
		refetchPage(await requireGeoServerFnPrincipal(data.organizationId, "site.crawl"), data.pageId),
	);

export const getKeyUrlCoverageFn = createServerFn({ method: "GET" })
	.validator(org.extend({ siteId: z.string().uuid() }))
	.handler(async ({ data }) =>
		getKeyUrlCoverage(await requireGeoServerFnPrincipal(data.organizationId, "site.read"), data.siteId),
	);

export const setKeyUrlsFn = createServerFn({ method: "POST" })
	.validator(org.extend({ siteId: z.string().uuid(), urls: z.array(z.string().min(1).max(2000)).max(2000) }))
	.handler(async ({ data }) =>
		setKeyUrls(await requireGeoServerFnPrincipal(data.organizationId, "site.manage"), data.siteId, data.urls),
	);

export const listQaSamplesFn = createServerFn({ method: "GET" })
	.validator(org.extend({ siteId: z.string().uuid() }))
	.handler(async ({ data }) =>
		listQaSamples(await requireGeoServerFnPrincipal(data.organizationId, "site.read"), data.siteId),
	);

export const createQaSampleFn = createServerFn({ method: "POST" })
	.validator(org.extend({ siteId: z.string().uuid(), size: z.number().int().min(1).max(500).optional() }))
	.handler(async ({ data }) =>
		createQaSample(await requireGeoServerFnPrincipal(data.organizationId, "site.crawl"), data.siteId, data.size),
	);

export const getQaSampleFn = createServerFn({ method: "GET" })
	.validator(org.extend({ sampleId: z.string().uuid() }))
	.handler(async ({ data }) =>
		getQaSample(await requireGeoServerFnPrincipal(data.organizationId, "site.read"), data.sampleId),
	);

export const labelQaItemFn = createServerFn({ method: "POST" })
	.validator(org.extend({ itemId: z.string().uuid() }).merge(qaLabelSchema))
	.handler(async ({ data }) =>
		labelQaItem(await requireGeoServerFnPrincipal(data.organizationId, "site.crawl"), data.itemId, data),
	);
