import { GEO_QUEUE, GeoError, type GeoParseStatus } from "@workspace/geo-domain";
import { geoObjectKey, normalizeUrl } from "@workspace/geo-evidence";
import type { DbConnection } from "@workspace/lib/db/db-connection";
import {
	geoSiteCrawlItems,
	geoSiteCrawlRuns,
	geoSitePages,
	geoSitePageVersions,
	geoSiteSources,
} from "@workspace/lib/db/schema";
import { and, desc, eq } from "drizzle-orm";
import type { ParsedPage } from "../contracts";
import { decodeStoredHtml } from "../net/charset";
import { parseSitePage } from "../parser";
import { parserVersionOf, type SiteProfile } from "../profile";
import { truncate } from "../text";
import type { SiteJobDeps } from "./deps";
import { runConfigOf } from "./runs";
import { loadProfileVersion, profileOfSource } from "./sources";

export type PageVersionRow = typeof geoSitePageVersions.$inferSelect;

/** What the version row carries inline; the full parse lives in object storage. */
export interface ParsedSummary {
	category: string | null;
	categoryLabel: string | null;
	entityKind: string | null;
	role: string | null;
	title: string | null;
	metaDescription: string | null;
	h1: string | null;
	canonical: string | null;
	publishedAt: string | null;
	textLength: number;
	excerpt: string;
	imageCount: number;
	images: string[];
	tableCount: number;
	fields: Array<{
		path: string;
		label: string | null;
		type: string;
		value: string | string[] | string[][] | null;
		selector: string | null;
	}>;
	warnings: string[];
	error: string | null;
}

type SummaryValue = ParsedSummary["fields"][number]["value"];

function shorten(value: SummaryValue): SummaryValue {
	if (typeof value === "string") return truncate(value, 500);
	if (!Array.isArray(value)) return value;
	return value
		.slice(0, 20)
		.map((entry) => (Array.isArray(entry) ? entry.map((cell) => truncate(cell, 200)) : truncate(entry, 500))) as
		| string[]
		| string[][];
}

const EMPTY_SUMMARY: Omit<ParsedSummary, "error"> = {
	category: null,
	categoryLabel: null,
	entityKind: null,
	role: null,
	title: null,
	metaDescription: null,
	h1: null,
	canonical: null,
	publishedAt: null,
	textLength: 0,
	excerpt: "",
	imageCount: 0,
	images: [],
	tableCount: 0,
	fields: [],
	warnings: [],
};

function summarize(page: ParsedPage | null, error: string | null): ParsedSummary {
	if (!page) return { ...EMPTY_SUMMARY, error };
	return {
		category: page.category,
		categoryLabel: page.categoryLabel,
		entityKind: page.entityKind,
		role: page.role,
		title: page.title,
		metaDescription: page.metaDescription,
		h1: page.h1,
		canonical: page.canonical,
		publishedAt: page.publishedAt,
		textLength: page.text.length,
		excerpt: truncate(page.text, 300),
		imageCount: page.images.length,
		images: page.images.slice(0, 10).map((image) => image.src),
		tableCount: page.tables.length,
		fields: page.fields.map((field) => ({
			path: field.path,
			label: field.label,
			type: field.type,
			value: shorten(field.value),
			selector: field.locator?.selector ?? null,
		})),
		warnings: page.warnings,
		error,
	};
}

function slug(value: string): string {
	return value.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 80);
}

export async function loadParsedPage(
	deps: Pick<SiteJobDeps, "objectStore">,
	version: Pick<PageVersionRow, "parsedObjectKey">,
): Promise<ParsedPage | null> {
	if (!version.parsedObjectKey) return null;
	const object = await deps.objectStore.get(version.parsedObjectKey);
	if (!object) return null;
	return JSON.parse(new TextDecoder().decode(object.body)) as ParsedPage;
}

/**
 * A parse of what the page serves now becomes its current version; one of older
 * content, finishing late or asked for on purpose, stays in the history.
 */
async function showIfCurrentContent(
	db: DbConnection,
	version: Pick<PageVersionRow, "id" | "pageId" | "contentHash">,
): Promise<void> {
	await db
		.update(geoSitePages)
		.set({ currentVersionId: version.id })
		.where(and(eq(geoSitePages.id, version.pageId), eq(geoSitePages.currentContentHash, version.contentHash)));
}

/**
 * Parses stored HTML into a new immutable version. The unique key on page,
 * content hash and parser version makes a repeat a no-op, which is what keeps
 * repeated runs and repeated re-parses from minting duplicate versions.
 */
export async function createParsedVersion(
	deps: Pick<SiteJobDeps, "db" | "objectStore">,
	input: {
		organizationId: string;
		siteSourceId: string;
		pageId: string;
		url: string;
		fetchedUrl: string | null;
		rawObjectKey: string;
		contentHash: string;
		fetchedAt: Date;
		profile: SiteProfile;
	},
): Promise<{ version: PageVersionRow; created: boolean }> {
	const parserVersion = parserVersionOf(input.profile);
	const [existing] = await deps.db
		.select()
		.from(geoSitePageVersions)
		.where(
			and(
				eq(geoSitePageVersions.pageId, input.pageId),
				eq(geoSitePageVersions.contentHash, input.contentHash),
				eq(geoSitePageVersions.parserVersion, parserVersion),
			),
		)
		.limit(1);
	if (existing) {
		await showIfCurrentContent(deps.db, existing);
		return { version: existing, created: false };
	}

	const raw = await deps.objectStore.get(input.rawObjectKey);
	if (!raw) throw new GeoError("NOT_FOUND", "原始快照不存在，无法解析");
	const html = decodeStoredHtml(raw.body, raw.contentType);
	const outcome = parseSitePage(html, input.url, input.profile, input.fetchedUrl ?? input.url);
	const page = outcome.page;
	const parseStatus: GeoParseStatus = outcome.status === "PARSED" ? "PARSED" : "FAILED";
	const error = outcome.status === "FAILED" ? outcome.message : null;

	let parsedObjectKey: string | null = null;
	if (page) {
		parsedObjectKey = geoObjectKey(
			input.organizationId,
			"site",
			input.siteSourceId,
			"parsed",
			`${input.pageId}-${input.contentHash.slice(0, 16)}-${slug(parserVersion)}.json`,
		);
		await deps.objectStore.put(parsedObjectKey, JSON.stringify(page), { contentType: "application/json" });
	}
	const [inserted] = await deps.db
		.insert(geoSitePageVersions)
		.values({
			organizationId: input.organizationId,
			pageId: input.pageId,
			contentHash: input.contentHash,
			parserVersion,
			htmlObjectKey: input.rawObjectKey,
			parsedObjectKey,
			fetchedUrl: input.fetchedUrl,
			title: page?.title ?? null,
			parsed: summarize(page, error),
			fetchedAt: input.fetchedAt,
			parseStatus,
			errorCode: outcome.status === "FAILED" ? outcome.errorCode : null,
		})
		.onConflictDoNothing()
		.returning();
	if (inserted) {
		if (page) {
			await deps.db.update(geoSitePages).set({ category: page.category }).where(eq(geoSitePages.id, input.pageId));
		}
		await showIfCurrentContent(deps.db, inserted);
		return { version: inserted, created: true };
	}
	const [raced] = await deps.db
		.select()
		.from(geoSitePageVersions)
		.where(
			and(
				eq(geoSitePageVersions.pageId, input.pageId),
				eq(geoSitePageVersions.contentHash, input.contentHash),
				eq(geoSitePageVersions.parserVersion, parserVersion),
			),
		)
		.limit(1);
	await showIfCurrentContent(deps.db, raced);
	return { version: raced, created: false };
}

async function enqueueNormalize(deps: Pick<SiteJobDeps, "send">, version: PageVersionRow) {
	if (version.parseStatus !== "PARSED") return null;
	return deps.send(
		GEO_QUEUE.siteNormalize,
		{ organizationId: version.organizationId, versionId: version.id },
		{ singletonKey: `normalize:${version.id}` },
	);
}

/** parse.site-page for a freshly fetched page. */
export async function parseCrawlItem(deps: SiteJobDeps, input: { organizationId: string; itemId: string }) {
	const [item] = await deps.db
		.select()
		.from(geoSiteCrawlItems)
		.where(and(eq(geoSiteCrawlItems.organizationId, input.organizationId), eq(geoSiteCrawlItems.id, input.itemId)))
		.limit(1);
	if (!item || item.outcome !== "NEW_VERSION" || item.versionId || !item.rawObjectKey || !item.pageId) return null;
	if (!item.contentHash || !item.fetchedAt) return null;
	const [run] = await deps.db.select().from(geoSiteCrawlRuns).where(eq(geoSiteCrawlRuns.id, item.runId)).limit(1);
	const [source] = await deps.db.select().from(geoSiteSources).where(eq(geoSiteSources.id, run.siteSourceId)).limit(1);
	const profile = await loadProfileVersion(
		deps.db,
		input.organizationId,
		source.id,
		runConfigOf(run).profileVersion,
	).catch(() => profileOfSource(source));
	const { version } = await createParsedVersion(deps, {
		organizationId: input.organizationId,
		siteSourceId: source.id,
		pageId: item.pageId,
		url: normalizeUrl(item.finalUrl ?? item.url) ?? item.url,
		fetchedUrl: item.finalUrl ?? item.url,
		rawObjectKey: item.rawObjectKey,
		contentHash: item.contentHash,
		fetchedAt: item.fetchedAt,
		profile,
	});
	await deps.db.update(geoSiteCrawlItems).set({ versionId: version.id }).where(eq(geoSiteCrawlItems.id, item.id));
	await enqueueNormalize(deps, version);
	return version;
}

/** What the page shows now, or until its first parse lands, the newest version it has. */
export async function currentVersionOf(
	db: DbConnection,
	page: { id: string; currentVersionId: string | null },
): Promise<PageVersionRow | null> {
	const [version] = await db
		.select()
		.from(geoSitePageVersions)
		.where(
			page.currentVersionId
				? eq(geoSitePageVersions.id, page.currentVersionId)
				: eq(geoSitePageVersions.pageId, page.id),
		)
		.orderBy(desc(geoSitePageVersions.fetchedAt), desc(geoSitePageVersions.createdAt))
		.limit(1);
	return version ?? null;
}

/**
 * Re-parses stored HTML with a chosen profile version. Nothing is downloaded:
 * the raw snapshot of the chosen (or current) version is the input.
 */
export async function reparseSitePage(
	deps: SiteJobDeps,
	input: { organizationId: string; pageId: string; versionId?: string | null; profileVersion?: number | null },
) {
	const [page] = await deps.db
		.select()
		.from(geoSitePages)
		.where(and(eq(geoSitePages.organizationId, input.organizationId), eq(geoSitePages.id, input.pageId)))
		.limit(1);
	if (!page) throw new GeoError("NOT_FOUND", "页面不存在");
	const base = input.versionId
		? (
				await deps.db
					.select()
					.from(geoSitePageVersions)
					.where(and(eq(geoSitePageVersions.pageId, page.id), eq(geoSitePageVersions.id, input.versionId)))
					.limit(1)
			)[0]
		: await currentVersionOf(deps.db, page);
	if (!base) throw new GeoError("NOT_FOUND", "页面还没有可重新解析的版本");
	if (base.parseStatus === "SKIPPED") throw new GeoError("VALIDATION_ERROR", "附件版本不需要解析");
	const [source] = await deps.db.select().from(geoSiteSources).where(eq(geoSiteSources.id, page.siteSourceId)).limit(1);
	const profile = input.profileVersion
		? await loadProfileVersion(deps.db, input.organizationId, source.id, input.profileVersion)
		: profileOfSource(source);
	const { version, created } = await createParsedVersion(deps, {
		organizationId: input.organizationId,
		siteSourceId: source.id,
		pageId: page.id,
		url: page.normalizedUrl,
		fetchedUrl: base.fetchedUrl,
		rawObjectKey: base.htmlObjectKey,
		contentHash: base.contentHash,
		fetchedAt: base.fetchedAt,
		profile,
	});
	if (created) await enqueueNormalize(deps, version);
	return { version, created };
}
