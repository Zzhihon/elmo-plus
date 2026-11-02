import type { DbConnection } from "@workspace/lib/db/db-connection";
import { type BatchComparison, compareBatches } from "../compare";
import { loadBatchSamples } from "./samples";

export * from "./samples";

/**
 * The retest comparison a task links to: its baseline and retest batches, compared on the
 * questions both sampled, per platform and surface mode.
 */
export async function compareOrganizationBatches(
	db: DbConnection,
	organizationId: string,
	beforeBatchId: string,
	afterBatchId: string,
	promptId?: string | null,
): Promise<BatchComparison> {
	const [before, after] = await Promise.all([
		loadBatchSamples(db, organizationId, beforeBatchId, promptId),
		loadBatchSamples(db, organizationId, afterBatchId, promptId),
	]);
	return compareBatches({ batchId: beforeBatchId, samples: before }, { batchId: afterBatchId, samples: after });
}
