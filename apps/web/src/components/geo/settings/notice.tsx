import { Alert, AlertDescription } from "@workspace/ui/components/alert";

export function ResultNotice({ error, success }: { error: string | null; success?: string | null }) {
	if (error) {
		return (
			<Alert variant="destructive">
				<AlertDescription>{error}</AlertDescription>
			</Alert>
		);
	}
	if (success) {
		return (
			<Alert>
				<AlertDescription>{success}</AlertDescription>
			</Alert>
		);
	}
	return null;
}
