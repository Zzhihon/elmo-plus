import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireGeoServerFnPrincipal } from "./context";
import {
	createNextPromptSetVersion,
	createPrompt,
	createPromptSet,
	exportPromptsCsv,
	freezePromptSet,
	getPrompt,
	getPromptSet,
	importPromptsCsv,
	listBuyerRoles,
	listGeoMembers,
	listPromptOptions,
	listPromptSets,
	listPrompts,
	promptInputSchema,
	promptListQuerySchema,
	promptPatchSchema,
	promptRoleCoverage,
	promptSetInputSchema,
	promptSetItemsSchema,
	promptStatusCounts,
	promptTransitionSchema,
	transitionPrompt,
	updatePrompt,
	updatePromptSetItems,
} from "./prompts-core";

const org = { organizationId: z.string() };
const PAGE_SIZE = 20;

export const getGeoQuestionsContextFn = createServerFn({ method: "GET" })
	.validator(z.object(org))
	.handler(async ({ data }) => {
		const principal = await requireGeoServerFnPrincipal(data.organizationId, "prompt.read");
		const [roles, members, counts, coverage] = await Promise.all([
			listBuyerRoles(principal),
			listGeoMembers(principal),
			promptStatusCounts(principal),
			promptRoleCoverage(principal),
		]);
		return { roles, members, counts, coverage };
	});

export const listGeoPromptsFn = createServerFn({ method: "GET" })
	.validator(
		z.object({
			...org,
			query: promptListQuerySchema,
			page: z.number().int().min(1).default(1),
			pageSize: z.number().int().min(1).max(100).default(PAGE_SIZE),
		}),
	)
	.handler(async ({ data }) => {
		const principal = await requireGeoServerFnPrincipal(data.organizationId, "prompt.read");
		const { rows, total } = await listPrompts(principal, data.query, {
			limit: data.pageSize,
			offset: (data.page - 1) * data.pageSize,
		});
		return { rows, total, page: data.page, totalPages: Math.max(1, Math.ceil(total / data.pageSize)) };
	});

export const getGeoPromptFn = createServerFn({ method: "GET" })
	.validator(z.object({ ...org, promptId: z.uuid() }))
	.handler(async ({ data }) => {
		const principal = await requireGeoServerFnPrincipal(data.organizationId, "prompt.read");
		return getPrompt(principal, data.promptId);
	});

export const createGeoPromptFn = createServerFn({ method: "POST" })
	.validator(z.object({ ...org, prompt: promptInputSchema }))
	.handler(async ({ data }) => {
		const principal = await requireGeoServerFnPrincipal(data.organizationId, "prompt.write");
		return createPrompt(principal, data.prompt);
	});

export const updateGeoPromptFn = createServerFn({ method: "POST" })
	.validator(z.object({ ...org, promptId: z.uuid(), patch: promptPatchSchema }))
	.handler(async ({ data }) => {
		const principal = await requireGeoServerFnPrincipal(data.organizationId, "prompt.write");
		return updatePrompt(principal, data.promptId, data.patch);
	});

export const transitionGeoPromptFn = createServerFn({ method: "POST" })
	.validator(z.object({ ...org, promptId: z.uuid(), transition: promptTransitionSchema }))
	.handler(async ({ data }) => {
		const reviewing = data.transition.action === "APPROVE" || data.transition.action === "REJECT";
		const principal = await requireGeoServerFnPrincipal(
			data.organizationId,
			reviewing ? "prompt.review" : "prompt.write",
		);
		return transitionPrompt(principal, data.promptId, data.transition);
	});

export const listGeoPromptSetsFn = createServerFn({ method: "GET" })
	.validator(z.object(org))
	.handler(async ({ data }) => {
		const principal = await requireGeoServerFnPrincipal(data.organizationId, "prompt.read");
		return listPromptSets(principal);
	});

export const getGeoPromptSetFn = createServerFn({ method: "GET" })
	.validator(z.object({ ...org, setId: z.uuid() }))
	.handler(async ({ data }) => {
		const principal = await requireGeoServerFnPrincipal(data.organizationId, "prompt.read");
		return getPromptSet(principal, data.setId);
	});

export const createGeoPromptSetFn = createServerFn({ method: "POST" })
	.validator(z.object({ ...org, set: promptSetInputSchema }))
	.handler(async ({ data }) => {
		const principal = await requireGeoServerFnPrincipal(data.organizationId, "prompt.write");
		return createPromptSet(principal, data.set);
	});

export const updateGeoPromptSetItemsFn = createServerFn({ method: "POST" })
	.validator(z.object({ ...org, setId: z.uuid(), items: promptSetItemsSchema }))
	.handler(async ({ data }) => {
		const principal = await requireGeoServerFnPrincipal(data.organizationId, "prompt.write");
		return updatePromptSetItems(principal, data.setId, data.items);
	});

export const createGeoPromptSetVersionFn = createServerFn({ method: "POST" })
	.validator(z.object({ ...org, setId: z.uuid() }))
	.handler(async ({ data }) => {
		const principal = await requireGeoServerFnPrincipal(data.organizationId, "prompt.write");
		return createNextPromptSetVersion(principal, data.setId);
	});

export const freezeGeoPromptSetFn = createServerFn({ method: "POST" })
	.validator(z.object({ ...org, setId: z.uuid() }))
	.handler(async ({ data }) => {
		const principal = await requireGeoServerFnPrincipal(data.organizationId, "prompt.freeze");
		const frozen = await freezePromptSet(principal, data.setId);
		return { id: frozen.id, name: frozen.name, version: frozen.version, itemCount: frozen.items.length };
	});

export const exportGeoPromptsCsvFn = createServerFn({ method: "GET" })
	.validator(z.object({ ...org, query: promptListQuerySchema }))
	.handler(async ({ data }) => {
		const principal = await requireGeoServerFnPrincipal(data.organizationId, "prompt.read");
		return { csv: await exportPromptsCsv(principal, data.query) };
	});

export const importGeoPromptsCsvFn = createServerFn({ method: "POST" })
	.validator(z.object({ ...org, csv: z.string().max(2 * 1024 * 1024) }))
	.handler(async ({ data }) => {
		const principal = await requireGeoServerFnPrincipal(data.organizationId, "prompt.write");
		return importPromptsCsv(principal, data.csv);
	});

export const listGeoMembersFn = createServerFn({ method: "GET" })
	.validator(z.object(org))
	.handler(async ({ data }) => {
		const principal = await requireGeoServerFnPrincipal(data.organizationId, "prompt.read");
		return listGeoMembers(principal);
	});

export const listGeoPromptOptionsFn = createServerFn({ method: "GET" })
	.validator(z.object(org))
	.handler(async ({ data }) => {
		const principal = await requireGeoServerFnPrincipal(data.organizationId, "prompt.read");
		return listPromptOptions(principal);
	});
