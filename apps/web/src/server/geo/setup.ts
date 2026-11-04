import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireGeoServerFnPrincipal } from "./context";
import { catalogSelectionSchema, getQuestionCatalog, saveCatalogSelection } from "./setup-core";

const org = z.object({ organizationId: z.string() });

export const getQuestionCatalogFn = createServerFn({ method: "GET" })
	.validator(org)
	.handler(async ({ data }) =>
		getQuestionCatalog(await requireGeoServerFnPrincipal(data.organizationId, "prompt.read")),
	);

export const saveCatalogSelectionFn = createServerFn({ method: "POST" })
	.validator(org.extend(catalogSelectionSchema.shape))
	.handler(async ({ data }) => {
		const principal = await requireGeoServerFnPrincipal(data.organizationId, "prompt.select_catalog");
		return saveCatalogSelection(principal, { codes: data.codes });
	});
