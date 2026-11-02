import { createServerFn } from "@tanstack/react-start";
import { GEO_ACTIVE_STATUSES } from "@workspace/geo-domain";
import { z } from "zod";
import { requireGeoServerFnPrincipal } from "./context";
import {
	brandInputSchema,
	brandPatchSchema,
	createBrand,
	createProduct,
	getBrand,
	getDictionaryVersionDetail,
	listBrands,
	listDictionaryVersions,
	productInputSchema,
	productPatchSchema,
	updateBrand,
	updateProduct,
} from "./profile-core";

const org = { organizationId: z.string() };

export const listGeoBrandsFn = createServerFn({ method: "GET" })
	.validator(z.object(org))
	.handler(async ({ data }) => {
		const principal = await requireGeoServerFnPrincipal(data.organizationId, "brand.read");
		return listBrands(principal);
	});

export const getGeoBrandFn = createServerFn({ method: "GET" })
	.validator(z.object({ ...org, brandId: z.uuid() }))
	.handler(async ({ data }) => {
		const principal = await requireGeoServerFnPrincipal(data.organizationId, "brand.read");
		return getBrand(principal, data.brandId);
	});

export const createGeoBrandFn = createServerFn({ method: "POST" })
	.validator(z.object({ ...org, brand: brandInputSchema }))
	.handler(async ({ data }) => {
		const principal = await requireGeoServerFnPrincipal(data.organizationId, "brand.manage");
		return createBrand(principal, data.brand);
	});

export const updateGeoBrandFn = createServerFn({ method: "POST" })
	.validator(z.object({ ...org, brandId: z.uuid(), patch: brandPatchSchema }))
	.handler(async ({ data }) => {
		const principal = await requireGeoServerFnPrincipal(data.organizationId, "brand.manage");
		return updateBrand(principal, data.brandId, data.patch);
	});

export const setGeoBrandStatusFn = createServerFn({ method: "POST" })
	.validator(z.object({ ...org, brandId: z.uuid(), status: z.enum(GEO_ACTIVE_STATUSES) }))
	.handler(async ({ data }) => {
		const principal = await requireGeoServerFnPrincipal(data.organizationId, "brand.manage");
		return updateBrand(principal, data.brandId, { status: data.status });
	});

export const createGeoProductFn = createServerFn({ method: "POST" })
	.validator(z.object({ ...org, brandId: z.uuid(), product: productInputSchema }))
	.handler(async ({ data }) => {
		const principal = await requireGeoServerFnPrincipal(data.organizationId, "brand.manage");
		return createProduct(principal, data.brandId, data.product);
	});

export const updateGeoProductFn = createServerFn({ method: "POST" })
	.validator(z.object({ ...org, brandId: z.uuid(), productId: z.uuid(), patch: productPatchSchema }))
	.handler(async ({ data }) => {
		const principal = await requireGeoServerFnPrincipal(data.organizationId, "brand.manage");
		return updateProduct(principal, data.brandId, data.productId, data.patch);
	});

export const listGeoDictionaryVersionsFn = createServerFn({ method: "GET" })
	.validator(z.object({ ...org, page: z.number().int().min(1).default(1) }))
	.handler(async ({ data }) => {
		const principal = await requireGeoServerFnPrincipal(data.organizationId, "brand.read");
		const limit = 20;
		const { rows, total } = await listDictionaryVersions(principal, { limit, offset: (data.page - 1) * limit });
		return { rows, total, page: data.page, totalPages: Math.max(1, Math.ceil(total / limit)) };
	});

export const getGeoDictionaryVersionFn = createServerFn({ method: "GET" })
	.validator(z.object({ ...org, version: z.number().int().min(1) }))
	.handler(async ({ data }) => {
		const principal = await requireGeoServerFnPrincipal(data.organizationId, "brand.read");
		return getDictionaryVersionDetail(principal, data.version);
	});
