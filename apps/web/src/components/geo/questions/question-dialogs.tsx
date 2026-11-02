import { useMutation } from "@tanstack/react-query";
import { geoErrorMessage } from "@/components/geo/brands/format";
import {
	createGeoPromptFn,
	importGeoPromptsCsvFn,
	transitionGeoPromptFn,
	updateGeoPromptFn,
} from "@/server/geo/prompts";
import type { GeoBuyerRole, GeoMemberOption, GeoPromptRow } from "@/server/geo/prompts-core";
import { PromptActionDialog, type PromptDialogAction } from "./prompt-action-dialog";
import { PromptFormDialog, type PromptFormValues, promptPayload } from "./prompt-form-dialog";
import { PromptImportDialog } from "./prompt-import-dialog";
import { useInvalidateQuestions } from "./use-invalidate-questions";

export function PromptEditorHost({
	organizationId,
	prompt,
	roles,
	members,
	onClose,
}: {
	organizationId: string;
	prompt: GeoPromptRow | null;
	roles: GeoBuyerRole[];
	members: GeoMemberOption[];
	onClose: () => void;
}) {
	const refresh = useInvalidateQuestions(organizationId);
	const save = useMutation({
		mutationFn: (values: PromptFormValues) =>
			prompt
				? updateGeoPromptFn({ data: { organizationId, promptId: prompt.id, patch: promptPayload(values) } })
				: createGeoPromptFn({ data: { organizationId, prompt: promptPayload(values) } }),
		onSuccess: async () => {
			onClose();
			await refresh();
		},
	});
	return (
		<PromptFormDialog
			prompt={prompt}
			roles={roles}
			members={members}
			pending={save.isPending}
			error={save.error ? geoErrorMessage(save.error) : null}
			onOpenChange={(open) => !open && onClose()}
			onSubmit={(values) => save.mutate(values)}
		/>
	);
}

export function PromptActionHost({
	organizationId,
	prompt,
	action,
	onClose,
}: {
	organizationId: string;
	prompt: GeoPromptRow;
	action: PromptDialogAction;
	onClose: () => void;
}) {
	const refresh = useInvalidateQuestions(organizationId);
	const transition = useMutation({
		mutationFn: (comment: string) =>
			transitionGeoPromptFn({
				data: { organizationId, promptId: prompt.id, transition: { action, comment: comment || null } },
			}),
		onSuccess: async () => {
			onClose();
			await refresh();
		},
	});
	return (
		<PromptActionDialog
			action={action}
			question={prompt.question}
			pending={transition.isPending}
			error={transition.error ? geoErrorMessage(transition.error) : null}
			onOpenChange={(open) => !open && onClose()}
			onConfirm={(comment) => transition.mutate(comment)}
		/>
	);
}

export function PromptImportHost({ organizationId, onClose }: { organizationId: string; onClose: () => void }) {
	const refresh = useInvalidateQuestions(organizationId);
	const importCsv = useMutation({
		mutationFn: (csv: string) => importGeoPromptsCsvFn({ data: { organizationId, csv } }),
		onSuccess: async (result) => {
			if (result.errors.length === 0) await refresh();
		},
	});
	return (
		<PromptImportDialog
			pending={importCsv.isPending}
			error={importCsv.error ? geoErrorMessage(importCsv.error) : null}
			result={importCsv.data ?? null}
			onOpenChange={(open) => !open && onClose()}
			onImport={(csv) => importCsv.mutate(csv)}
		/>
	);
}
