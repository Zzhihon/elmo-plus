/**
 * The weekly browser-agent round: an agent driving the user's own signed-in browser
 * reads the plan, asks each question on each app, and sends back what it saw.
 */
import { BROWSER_FAILURE_CODES, BROWSER_IMPORT_MAX_ROWS } from "@workspace/geo-cn-providers";
import { GeoError, type GeoPrincipal } from "@workspace/geo-domain";
import { z } from "zod";
import { ApiError } from "@/lib/api/handler";
import type { Principal } from "@/lib/auth/api-auth";
import {
	browserEvidenceInputSchema,
	getBrowserSamplingPlan,
	importBrowserObservations,
	uploadBrowserEvidence,
} from "@/server/geo/browser-agent-core";
import { resolveGeoMcpPrincipal } from "@/server/geo/context";
import { defineTool } from "./define";

/** A GEO refusal carries a message the agent can act on, so it surfaces as an expected failure. */
async function asGeo<T>(auth: Principal, run: (principal: GeoPrincipal) => Promise<T>): Promise<T> {
	try {
		return await run(await resolveGeoMcpPrincipal(auth));
	} catch (error) {
		if (error instanceof GeoError) throw new ApiError(error.status, error.code, error.message);
		if (error instanceof z.ZodError) {
			throw new ApiError(400, "VALIDATION_ERROR", error.issues.map((issue) => issue.message).join("; "));
		}
		throw error;
	}
}

const planKeyArg = z
	.string()
	.regex(/^\d{4}-W\d{2}$/)
	.describe('ISO week on the Asia/Shanghai clock, e.g. "2026-W45".');

export const getSamplingPlan = defineTool({
	name: "geo_get_sampling_plan",
	title: "Get the browser sampling plan",
	description:
		"This week's browser-agent sampling plan: the frozen monitoring questions, the AI apps to ask them on (each with its chat page URL), how many repeats, the runKeys already imported (do not ask those again) and runKeys whose last attempt failed (retry those with the same runKey), and the rules the runner must follow. A runKey is `<planKey>/<platform>/<promptId>/<repeat>`, repeat counting from 1.",
	scopes: ["geo:read"],
	readOnly: true,
	input: { planKey: planKeyArg.optional().describe("Defaults to the current week in Asia/Shanghai.") },
	run: ({ auth }, args) => asGeo(auth, (principal) => getBrowserSamplingPlan(principal, { planKey: args.planKey })),
});

export const uploadEvidence = defineTool({
	name: "geo_upload_evidence",
	title: "Upload a sampling screenshot",
	description:
		"Store one screenshot (PNG or JPEG) or PDF of an AI app's answer, at most 10 MB, and get the evidenceRef to put in a row's evidenceRefs. The file is virus-scanned; the bytes decide its type, not the name. Upload first, then import the rows that reference it in the same session.",
	scopes: ["geo:write"],
	readOnly: false,
	destructive: false,
	input: {
		fileName: browserEvidenceInputSchema.shape.fileName.describe("Original file name, for the record only."),
		contentType: browserEvidenceInputSchema.shape.contentType,
		contentBase64: browserEvidenceInputSchema.shape.contentBase64.describe("The file's bytes, base64-encoded."),
	},
	run: ({ auth }, args) => asGeo(auth, (principal) => uploadBrowserEvidence(principal, args)),
});

const rowShape = z
	.object({
		runKey: z.string().describe("<planKey>/<platform>/<promptId>/<repeat>; the idempotency key."),
		planKey: z.string(),
		platform: z.string().describe("Platform code from the plan, e.g. doubao."),
		promptId: z.string(),
		question: z.string().describe("The exact text typed into the app."),
		sampledAt: z.string().describe("ISO 8601 with offset, when the answer finished."),
		status: z.enum(["VALID", "PARTIAL", "FAILED"]),
		responseText: z.string().optional().describe("The full answer; required for VALID and PARTIAL."),
		citations: z
			.array(z.object({ url: z.string(), title: z.string().optional() }))
			.optional()
			.describe("Sources the app showed with the answer."),
		evidenceRefs: z
			.array(z.string())
			.optional()
			.describe("evidenceRefs from geo_upload_evidence; at least one for VALID and PARTIAL."),
		modelVersion: z.string().optional().describe("Model name shown in the app, if any."),
		session: z
			.object({
				account: z.string().optional().describe("A label for the account, never a credential."),
				loggedIn: z.boolean().optional(),
				deepThinking: z.boolean().optional(),
				webSearch: z.boolean().optional(),
				region: z.string().optional(),
			})
			.optional(),
		failure: z
			.object({ code: z.enum(BROWSER_FAILURE_CODES), message: z.string().optional() })
			.optional()
			.describe("Required for FAILED."),
		note: z.string().optional(),
	})
	.passthrough();

export const importBrowserObservationsTool = defineTool({
	name: "geo_import_browser_observations",
	title: "Import browser sampling results",
	description: `Record up to ${BROWSER_IMPORT_MAX_ROWS} results of the browser-agent round. Each row is checked on its own: rows with problems come back in \`errors\` by runKey and the rest are imported. Re-sending a runKey that already has an answer is skipped, never counted twice. FAILED rows are kept for the audit trail but never count as "not mentioned"; a later answer for the same runKey supersedes the failure. Answers are queued for evaluation.`,
	scopes: ["geo:write"],
	readOnly: false,
	destructive: false,
	input: {
		planKey: planKeyArg,
		rows: z.array(rowShape).min(1).max(BROWSER_IMPORT_MAX_ROWS),
	},
	run: ({ auth }, args) =>
		asGeo(auth, (principal) => importBrowserObservations(principal, { planKey: args.planKey, rows: args.rows })),
});

export const GEO_MCP_TOOLS = [getSamplingPlan, uploadEvidence, importBrowserObservationsTool];
