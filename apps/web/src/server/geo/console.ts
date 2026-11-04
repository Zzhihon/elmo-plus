import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getReplayAnswer, listConsoleQuestions, listReplaySamples } from "./console-core";
import { askLiveQuestion, getLiveSetup, listRecentLiveRuns, liveQuestionInputSchema } from "./console-live-core";
import { requireGeoServerFnPrincipal } from "./context";

const org = z.object({ organizationId: z.string() });

export const listConsoleQuestionsFn = createServerFn({ method: "GET" })
	.validator(org)
	.handler(async ({ data }) =>
		listConsoleQuestions(await requireGeoServerFnPrincipal(data.organizationId, "console.read")),
	);

export const listReplaySamplesFn = createServerFn({ method: "GET" })
	.validator(org.extend({ promptId: z.guid() }))
	.handler(async ({ data }) =>
		listReplaySamples(await requireGeoServerFnPrincipal(data.organizationId, "console.read"), data.promptId),
	);

export const getReplayAnswerFn = createServerFn({ method: "GET" })
	.validator(org.extend({ observationId: z.guid() }))
	.handler(async ({ data }) =>
		getReplayAnswer(await requireGeoServerFnPrincipal(data.organizationId, "console.read"), data.observationId),
	);

export const getLiveSetupFn = createServerFn({ method: "GET" })
	.validator(org)
	.handler(async ({ data }) => getLiveSetup(await requireGeoServerFnPrincipal(data.organizationId, "console.read")));

export const listRecentLiveRunsFn = createServerFn({ method: "GET" })
	.validator(org)
	.handler(async ({ data }) =>
		listRecentLiveRuns(await requireGeoServerFnPrincipal(data.organizationId, "console.read")),
	);

export const askLiveQuestionFn = createServerFn({ method: "POST" })
	.validator(org.extend({ input: liveQuestionInputSchema }))
	.handler(async ({ data }) =>
		askLiveQuestion(await requireGeoServerFnPrincipal(data.organizationId, "console.simulate"), data.input),
	);
