import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireGeoServerFnPrincipal } from "./context";
import {
	batchRunsQuerySchema,
	createBatchInputSchema,
	createSamplingBatch,
	getSamplingBatch,
	listFrozenPromptSets,
	listSamplingBatches,
	pauseSamplingBatch,
	resampleInputSchema,
	resampleRun,
	resumeSamplingBatch,
} from "./sampling-core";
import {
	checkSamplingTargetConnectivity,
	createSamplingTarget,
	listSamplingTargets,
	setSamplingTargetCredential,
	setSamplingTargetEnabled,
	setSamplingTargetVerification,
	targetInputSchema,
	updateSamplingTarget,
	verificationInputSchema,
} from "./sampling-targets-core";

const org = z.object({ organizationId: z.string() });
const paging = z.object({
	page: z.number().int().min(1).default(1),
	limit: z.number().int().min(1).max(100).default(20),
});
const toPaging = ({ page, limit }: { page: number; limit: number }) => ({ page, limit, offset: (page - 1) * limit });

export const listSamplingTargetsFn = createServerFn({ method: "GET" })
	.validator(org)
	.handler(async ({ data }) =>
		listSamplingTargets(await requireGeoServerFnPrincipal(data.organizationId, "target.read")),
	);

export const createSamplingTargetFn = createServerFn({ method: "POST" })
	.validator(org.extend({ target: targetInputSchema }))
	.handler(async ({ data }) => {
		const principal = await requireGeoServerFnPrincipal(data.organizationId, "target.manage");
		const row = await createSamplingTarget(principal, data.target);
		return { id: row.id };
	});

export const updateSamplingTargetFn = createServerFn({ method: "POST" })
	.validator(org.extend({ targetId: z.guid(), target: targetInputSchema }))
	.handler(async ({ data }) => {
		const principal = await requireGeoServerFnPrincipal(data.organizationId, "target.manage");
		const row = await updateSamplingTarget(principal, data.targetId, data.target);
		return { id: row.id, verificationStatus: row.verificationStatus };
	});

export const setSamplingTargetEnabledFn = createServerFn({ method: "POST" })
	.validator(org.extend({ targetId: z.guid(), enabled: z.boolean() }))
	.handler(async ({ data }) => {
		const principal = await requireGeoServerFnPrincipal(data.organizationId, "target.manage");
		const row = await setSamplingTargetEnabled(principal, data.targetId, data.enabled);
		return { id: row.id, enabled: row.enabled };
	});

export const setSamplingTargetCredentialFn = createServerFn({ method: "POST" })
	.validator(org.extend({ targetId: z.guid(), value: z.string().max(4096).nullable() }))
	.handler(async ({ data }) => {
		const principal = await requireGeoServerFnPrincipal(data.organizationId, "secret.manage");
		return setSamplingTargetCredential(principal, data.targetId, data.value);
	});

export const checkSamplingTargetConnectivityFn = createServerFn({ method: "POST" })
	.validator(org.extend({ targetId: z.guid() }))
	.handler(async ({ data }) => {
		const principal = await requireGeoServerFnPrincipal(data.organizationId, "target.manage");
		return checkSamplingTargetConnectivity(principal, data.targetId);
	});

export const setSamplingTargetVerificationFn = createServerFn({ method: "POST" })
	.validator(org.extend({ targetId: z.guid(), verification: verificationInputSchema }))
	.handler(async ({ data }) => {
		const principal = await requireGeoServerFnPrincipal(data.organizationId, "target.manage");
		const row = await setSamplingTargetVerification(principal, data.targetId, data.verification);
		return { id: row.id, verificationStatus: row.verificationStatus };
	});

export const listFrozenPromptSetsFn = createServerFn({ method: "GET" })
	.validator(org)
	.handler(async ({ data }) =>
		listFrozenPromptSets(await requireGeoServerFnPrincipal(data.organizationId, "sampling.read")),
	);

export const createSamplingBatchFn = createServerFn({ method: "POST" })
	.validator(org.extend({ batch: createBatchInputSchema }))
	.handler(async ({ data }) => {
		const principal = await requireGeoServerFnPrincipal(data.organizationId, "sampling.run");
		const result = await createSamplingBatch(principal, data.batch);
		return {
			batchId: result.batch.id,
			created: result.created,
			jobId: result.jobId,
			plannedCount: result.batch.plannedCount,
		};
	});

export const listSamplingBatchesFn = createServerFn({ method: "GET" })
	.validator(org.extend(paging.shape))
	.handler(async ({ data }) => {
		const principal = await requireGeoServerFnPrincipal(data.organizationId, "sampling.read");
		const pages = toPaging(data);
		const { rows, total } = await listSamplingBatches(principal, pages);
		return { rows, total, page: pages.page, totalPages: Math.ceil(total / pages.limit) };
	});

export const getSamplingBatchFn = createServerFn({ method: "GET" })
	.validator(org.extend({ batchId: z.guid(), ...paging.shape, ...batchRunsQuerySchema.shape }))
	.handler(async ({ data }) => {
		const principal = await requireGeoServerFnPrincipal(data.organizationId, "sampling.read");
		const pages = toPaging(data);
		const detail = await getSamplingBatch(principal, data.batchId, pages, {
			status: data.status,
			targetId: data.targetId,
		});
		return { ...detail, page: pages.page, totalPages: Math.ceil(detail.runTotal / pages.limit) };
	});

export const setSamplingBatchPausedFn = createServerFn({ method: "POST" })
	.validator(org.extend({ batchId: z.guid(), paused: z.boolean() }))
	.handler(async ({ data }) => {
		const principal = await requireGeoServerFnPrincipal(data.organizationId, "sampling.run");
		const row = data.paused
			? await pauseSamplingBatch(principal, data.batchId)
			: await resumeSamplingBatch(principal, data.batchId);
		return { id: row.id, status: row.status };
	});

export const resampleRunFn = createServerFn({ method: "POST" })
	.validator(org.extend({ runId: z.guid(), ...resampleInputSchema.shape }))
	.handler(async ({ data }) => {
		const principal = await requireGeoServerFnPrincipal(data.organizationId, "sampling.run");
		return resampleRun(principal, data.runId, { reason: data.reason });
	});
