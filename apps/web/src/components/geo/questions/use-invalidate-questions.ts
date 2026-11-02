import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

const QUESTION_KEYS = [
	"geo-prompts",
	"geo-prompt",
	"geo-prompt-sets",
	"geo-prompt-set",
	"geo-prompt-options",
	"geo-questions-context",
];

/** A status change shows up in the list, the counts, the set picker and any open set, so all of them refetch. */
export function useInvalidateQuestions(organizationId: string): () => Promise<void> {
	const queryClient = useQueryClient();
	return useCallback(async () => {
		await Promise.all(QUESTION_KEYS.map((key) => queryClient.invalidateQueries({ queryKey: [key, organizationId] })));
	}, [queryClient, organizationId]);
}
