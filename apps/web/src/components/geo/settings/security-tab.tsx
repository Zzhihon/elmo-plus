import { useQueryClient } from "@tanstack/react-query";
import { authClient } from "@workspace/lib/auth/client";
import { Button } from "@workspace/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@workspace/ui/components/card";
import { Input } from "@workspace/ui/components/input";
import { Label } from "@workspace/ui/components/label";
import { useState } from "react";
import { GeoStatusBadge } from "@/components/geo/shell/status-badge";
import { ResultNotice } from "./notice";
import { geoAdminKeys, useGeoSecurity } from "./queries";

interface Enrollment {
	uri: string;
	secret: string | null;
	backupCodes: string[];
}

function secretOf(uri: string): string | null {
	try {
		return new URL(uri).searchParams.get("secret");
	} catch {
		return null;
	}
}

function EnrollForm({ hasPassword, onDone }: { hasPassword: boolean; onDone: () => void }) {
	const [password, setPassword] = useState("");
	const [code, setCode] = useState("");
	const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function start(e: React.FormEvent) {
		e.preventDefault();
		setBusy(true);
		setError(null);
		const result = await authClient.twoFactor.enable(hasPassword ? { password } : {});
		setBusy(false);
		if (result.error || !result.data || result.data.method !== "totp") {
			setError(result.error?.message ?? "无法开始设置，请确认密码正确");
			return;
		}
		setPassword("");
		setEnrollment({
			uri: result.data.totpURI,
			secret: secretOf(result.data.totpURI),
			backupCodes: result.data.backupCodes,
		});
	}

	async function confirm(e: React.FormEvent) {
		e.preventDefault();
		setBusy(true);
		setError(null);
		const result = await authClient.twoFactor.verifyTotp({ code: code.trim() });
		setBusy(false);
		if (result.error) {
			setError("验证码不正确，请检查验证器应用的时间并重试");
			return;
		}
		onDone();
	}

	if (!enrollment) {
		return (
			<form onSubmit={start} className="flex max-w-sm flex-col gap-3">
				{hasPassword && (
					<>
						<Label htmlFor="mfa-password">输入当前登录密码以开始设置</Label>
						<Input
							id="mfa-password"
							type="password"
							autoComplete="current-password"
							value={password}
							onChange={(e) => setPassword(e.target.value)}
							required
						/>
					</>
				)}
				<ResultNotice error={error} />
				<Button type="submit" disabled={busy || (hasPassword && !password)}>
					开始设置两步验证
				</Button>
			</form>
		);
	}

	return (
		<form onSubmit={confirm} className="flex max-w-xl flex-col gap-4">
			<div className="space-y-2 text-sm">
				<p>1. 在验证器应用（如 Google Authenticator、Microsoft Authenticator）中手动添加账户，输入以下密钥：</p>
				<code className="block break-all rounded bg-muted p-2 font-mono">{enrollment.secret ?? enrollment.uri}</code>
				<p className="text-muted-foreground">也可以把下面的地址复制到支持 otpauth 链接的应用中：</p>
				<code className="block break-all rounded bg-muted p-2 font-mono text-xs">{enrollment.uri}</code>
			</div>
			<div className="space-y-2 text-sm">
				<p>2. 保存备用码。每个备用码只能使用一次，本页关闭后不会再次显示：</p>
				<div className="grid grid-cols-2 gap-1 rounded bg-muted p-2 font-mono sm:grid-cols-5">
					{enrollment.backupCodes.map((backup) => (
						<span key={backup}>{backup}</span>
					))}
				</div>
			</div>
			<div className="flex max-w-sm flex-col gap-2">
				<Label htmlFor="mfa-code">3. 输入验证器显示的 6 位验证码完成启用</Label>
				<Input
					id="mfa-code"
					inputMode="numeric"
					autoComplete="one-time-code"
					value={code}
					onChange={(e) => setCode(e.target.value)}
					required
				/>
			</div>
			<ResultNotice error={error} />
			<Button type="submit" className="w-fit" disabled={busy || code.trim().length < 6}>
				确认启用
			</Button>
		</form>
	);
}

function StepUpForm({ onDone }: { onDone: () => void }) {
	const [code, setCode] = useState("");
	const [useBackup, setUseBackup] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function submit(e: React.FormEvent) {
		e.preventDefault();
		setBusy(true);
		setError(null);
		const trimmed = code.trim();
		const result = useBackup
			? await authClient.twoFactor.verifyBackupCode({ code: trimmed })
			: await authClient.twoFactor.verifyTotp({ code: trimmed });
		setBusy(false);
		if (result.error) {
			setError("验证码不正确，请重试");
			return;
		}
		setCode("");
		onDone();
	}

	return (
		<form onSubmit={submit} className="flex max-w-sm flex-col gap-3">
			<Label htmlFor="mfa-step-up">
				{useBackup ? "输入一个备用码" : "输入验证器显示的 6 位验证码"}，完成本次登录的两步验证
			</Label>
			<Input
				id="mfa-step-up"
				autoComplete="one-time-code"
				value={code}
				onChange={(e) => setCode(e.target.value)}
				required
			/>
			<ResultNotice error={error} />
			<div className="flex items-center gap-2">
				<Button type="submit" disabled={busy || !code.trim()}>
					验证
				</Button>
				<Button type="button" variant="ghost" onClick={() => setUseBackup((value) => !value)}>
					{useBackup ? "改用验证码" : "改用备用码"}
				</Button>
			</div>
		</form>
	);
}

function DisableForm({ hasPassword, onDone }: { hasPassword: boolean; onDone: () => void }) {
	const [password, setPassword] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function submit(e: React.FormEvent) {
		e.preventDefault();
		setBusy(true);
		setError(null);
		const result = await authClient.twoFactor.disable(hasPassword ? { password } : {});
		setBusy(false);
		if (result.error) {
			setError(result.error.message ?? "关闭失败，请确认密码正确");
			return;
		}
		onDone();
	}

	return (
		<form onSubmit={submit} className="flex max-w-sm flex-col gap-3">
			{hasPassword && (
				<>
					<Label htmlFor="mfa-disable">输入密码关闭两步验证</Label>
					<Input
						id="mfa-disable"
						type="password"
						autoComplete="current-password"
						value={password}
						onChange={(e) => setPassword(e.target.value)}
						required
					/>
				</>
			)}
			<ResultNotice error={error} />
			<Button type="submit" variant="outline" disabled={busy || (hasPassword && !password)}>
				关闭两步验证
			</Button>
		</form>
	);
}

export function GeoSecurityTab({ organizationId }: { organizationId: string }) {
	const queryClient = useQueryClient();
	const { data } = useGeoSecurity(organizationId);
	const refresh = () => queryClient.invalidateQueries({ queryKey: geoAdminKeys.all(organizationId) });

	return (
		<Card>
			<CardHeader>
				<CardTitle className="flex items-center gap-2 text-base">
					两步验证
					{data && (
						<GeoStatusBadge
							label={data.twoFactorEnabled ? "已启用" : "未启用"}
							tone={data.twoFactorEnabled ? "success" : "warning"}
						/>
					)}
				</CardTitle>
				<CardDescription>
					{data?.adminMfaRequired
						? "本组织要求平台管理员在本次登录中完成两步验证后才能使用管理设置。"
						: "本组织已通过双人审批关闭管理员两步验证要求，仍建议启用。"}
				</CardDescription>
			</CardHeader>
			<CardContent>
				{data?.sessionFactor === "SSO" && (
					<p className="text-sm text-muted-foreground">
						你通过单点登录（SSO）登录，两步验证由身份提供方负责，此处无需设置。
					</p>
				)}
				{data && data.sessionFactor !== "SSO" && !data.twoFactorEnabled && (
					<EnrollForm hasPassword={data.hasPassword} onDone={refresh} />
				)}
				{data && data.sessionFactor !== "SSO" && data.twoFactorEnabled && (
					<div className="flex flex-col gap-6">
						{data.sessionFactor === "TWO_FACTOR" ? (
							<>
								<p className="text-sm text-muted-foreground">本次登录已完成两步验证。</p>
								<DisableForm hasPassword={data.hasPassword} onDone={refresh} />
							</>
						) : (
							<StepUpForm onDone={refresh} />
						)}
					</div>
				)}
			</CardContent>
		</Card>
	);
}
