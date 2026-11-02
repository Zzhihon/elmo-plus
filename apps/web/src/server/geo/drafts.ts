import { createServerFn } from "@tanstack/react-start";
import { getDeployment } from "@workspace/deployment";
import { GeoError } from "@workspace/geo-domain";
import { z } from "zod";
import { READ_ONLY_MESSAGE } from "@/lib/read-only-errors";
import { requireGeoServerFnPrincipal, resolveGeoSessionPrincipal } from "./context";
import {
	createDraft,
	createDraftSchema,
	draftFiltersSchema,
	draftLinkTaskSchema,
	draftLlmStatus,
	draftTransitionSchema,
	getDraftDetail,
	getDraftVersion,
	linkDraftTask,
	listDrafts,
	listDraftTaskChoices,
	publicationSchema,
	recordPublication,
	reviseDraft,
	reviseDraftSchema,
	transitionDraft,
} from "./drafts-core";

const orgOnly = z.object({ organizationId: z.string() });
const draftRef = orgOnly.extend({ draftId: z.string().uuid() });

/** Reviewers and publishers hold different permissions; the content state machine decides. */
async function writablePrincipal(organizationId: string) {
	const principal = await resolveGeoSessionPrincipal(organizationId);
	if (getDeployment().features.readOnly) throw new GeoError("FORBIDDEN", READ_ONLY_MESSAGE);
	return principal;
}

export const listGeoDraftsFn = createServerFn({ method: "GET" })
	.validator(
		orgOnly.extend({
			filters: draftFiltersSchema.optional(),
			page: z.number().int().min(1).default(1),
			limit: z.number().int().min(1).max(100).default(20),
		}),
	)
	.handler(async ({ data }) => {
		const principal = await requireGeoServerFnPrincipal(data.organizationId, "content.read");
		const { rows, total } = await listDrafts(principal, data.filters ?? {}, {
			limit: data.limit,
			offset: (data.page - 1) * data.limit,
		});
		return { rows, total, page: data.page, totalPages: Math.max(1, Math.ceil(total / data.limit)) };
	});

export const getGeoDraftFn = createServerFn({ method: "GET" })
	.validator(draftRef)
	.handler(async ({ data }) => {
		const principal = await requireGeoServerFnPrincipal(data.organizationId, "content.read");
		return getDraftDetail(principal, data.draftId);
	});

export const getGeoDraftVersionFn = createServerFn({ method: "GET" })
	.validator(draftRef.extend({ version: z.number().int().min(1) }))
	.handler(async ({ data }) => {
		const principal = await requireGeoServerFnPrincipal(data.organizationId, "content.read");
		return getDraftVersion(principal, data.draftId, data.version);
	});

export const getGeoDraftChoicesFn = createServerFn({ method: "GET" })
	.validator(orgOnly)
	.handler(async ({ data }) => {
		const principal = await requireGeoServerFnPrincipal(data.organizationId, "content.read");
		const [llm, tasks] = await Promise.all([
			draftLlmStatus(principal),
			listDraftTaskChoices(principal).catch((error) => {
				if (error instanceof GeoError && error.code === "FORBIDDEN") return [];
				throw error;
			}),
		]);
		return { ...llm, tasks };
	});

export const createGeoDraftFn = createServerFn({ method: "POST" })
	.validator(orgOnly.extend({ input: createDraftSchema }))
	.handler(async ({ data }) => {
		const principal = await requireGeoServerFnPrincipal(data.organizationId, "content.write");
		return createDraft(principal, data.input);
	});

export const reviseGeoDraftFn = createServerFn({ method: "POST" })
	.validator(draftRef.extend({ input: reviseDraftSchema }))
	.handler(async ({ data }) => {
		const principal = await requireGeoServerFnPrincipal(data.organizationId, "content.write");
		return reviseDraft(principal, data.draftId, data.input);
	});

export const transitionGeoDraftFn = createServerFn({ method: "POST" })
	.validator(draftRef.extend({ input: draftTransitionSchema }))
	.handler(async ({ data }) => transitionDraft(await writablePrincipal(data.organizationId), data.draftId, data.input));

export const recordGeoDraftPublicationFn = createServerFn({ method: "POST" })
	.validator(draftRef.extend({ input: publicationSchema }))
	.handler(async ({ data }) => {
		const principal = await requireGeoServerFnPrincipal(data.organizationId, "content.publish");
		return recordPublication(principal, data.draftId, data.input);
	});

export const linkGeoDraftTaskFn = createServerFn({ method: "POST" })
	.validator(draftRef.extend({ input: draftLinkTaskSchema }))
	.handler(async ({ data }) => {
		const principal = await requireGeoServerFnPrincipal(data.organizationId, "content.write");
		return linkDraftTask(principal, data.draftId, data.input.taskId);
	});
