/**
 * /auth/two-factor - second step of an email sign-in for an account with a TOTP
 * factor. Reached only from the login page when the server answered
 * `twoFactorRedirect`, which happens only with the GEO workspace switched on.
 */

import { createFileRoute, Link } from "@tanstack/react-router";
import { authClient } from "@workspace/lib/auth/client";
import { Alert, AlertDescription } from "@workspace/ui/components/alert";
import { Button } from "@workspace/ui/components/button";
import { Checkbox } from "@workspace/ui/components/checkbox";
import { Input } from "@workspace/ui/components/input";
import { Label } from "@workspace/ui/components/label";
import { useState } from "react";
import FullPageCard from "@/components/full-page-card";
import { safeReturnTo } from "@/lib/return-to";
import { buildTitle, getAppName } from "@/lib/route-head";

interface TwoFactorSearch {
	returnTo?: string;
}

export const Route = createFileRoute("/auth/two-factor")({
	validateSearch: (search: Record<string, unknown>): TwoFactorSearch => ({
		returnTo: typeof search.returnTo === "string" ? search.returnTo : undefined,
	}),
	head: ({ match }) => ({
		meta: [{ title: buildTitle("Two-Factor Verification", { appName: getAppName(match) }) }],
	}),
	component: TwoFactorPage,
});

function TwoFactorPage() {
	const { returnTo } = Route.useSearch();
	const destination = safeReturnTo(returnTo);
	const [mode, setMode] = useState<"totp" | "backup">("totp");
	const [code, setCode] = useState("");
	const [trustDevice, setTrustDevice] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		setError(null);
		setLoading(true);
		const trimmed = code.trim();
		const result =
			mode === "totp"
				? await authClient.twoFactor.verifyTotp({ code: trimmed, trustDevice })
				: await authClient.twoFactor.verifyBackupCode({ code: trimmed, trustDevice });
		if (result.error) {
			setError(
				result.error.status === 401
					? "Your sign-in attempt expired. Sign in again."
					: "That code is not valid. Check your authenticator and try again.",
			);
			setLoading(false);
			return;
		}
		window.location.href = destination;
	}

	return (
		<FullPageCard
			title="Two-Factor Verification"
			subtitle={
				mode === "totp"
					? "Enter the 6-digit code from your authenticator app."
					: "Enter one of the backup codes you saved when you turned on two-factor authentication."
			}
		>
			<form onSubmit={handleSubmit} className="w-full space-y-4">
				{error && (
					<Alert variant="destructive">
						<AlertDescription>{error}</AlertDescription>
					</Alert>
				)}
				<div className="space-y-2">
					<Label htmlFor="code">{mode === "totp" ? "Authentication Code" : "Backup Code"}</Label>
					<Input
						id="code"
						value={code}
						onChange={(e) => setCode(e.target.value)}
						autoComplete="one-time-code"
						inputMode={mode === "totp" ? "numeric" : "text"}
						autoFocus
						required
					/>
				</div>
				<div className="flex items-center gap-2">
					<Checkbox id="trust" checked={trustDevice} onCheckedChange={(value) => setTrustDevice(value === true)} />
					<Label htmlFor="trust" className="text-sm font-normal">
						Trust this device for 30 days
					</Label>
				</div>
				<Button type="submit" className="w-full" disabled={loading || code.trim().length === 0}>
					{loading ? "Verifying..." : "Verify"}
				</Button>
				<div className="flex justify-between text-sm">
					<button
						type="button"
						className="text-muted-foreground underline"
						onClick={() => {
							setMode(mode === "totp" ? "backup" : "totp");
							setCode("");
							setError(null);
						}}
					>
						{mode === "totp" ? "Use a backup code" : "Use an authenticator code"}
					</button>
					<Link to="/auth/login" className="text-muted-foreground underline">
						Back to sign in
					</Link>
				</div>
			</form>
		</FullPageCard>
	);
}
