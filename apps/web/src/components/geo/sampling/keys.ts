export const samplingKeys = {
	all: (organizationId: string) => ["geo", "sampling", organizationId] as const,
	targets: (organizationId: string) => [...samplingKeys.all(organizationId), "targets"] as const,
	promptSets: (organizationId: string) => [...samplingKeys.all(organizationId), "prompt-sets"] as const,
	batches: (organizationId: string, page: number) => [...samplingKeys.all(organizationId), "batches", page] as const,
	batch: (organizationId: string, batchId: string, page: number, status?: string) =>
		[...samplingKeys.all(organizationId), "batch", batchId, page, status ?? null] as const,
};

export const observationKeys = {
	all: (organizationId: string) => ["geo", "observations", organizationId] as const,
	list: (organizationId: string, filters: object, page: number) =>
		[...observationKeys.all(organizationId), "list", filters, page] as const,
	detail: (organizationId: string, observationId: string) =>
		[...observationKeys.all(organizationId), "detail", observationId] as const,
};
