import { useQueryClient } from "@tanstack/react-query";
import { GEO_PLATFORM_LABELS } from "@workspace/geo-domain";
import { Button } from "@workspace/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@workspace/ui/components/card";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@workspace/ui/components/dialog";
import { Input } from "@workspace/ui/components/input";
import { Label } from "@workspace/ui/components/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@workspace/ui/components/table";
import { useState } from "react";
import { GeoStatusBadge } from "@/components/geo/shell/status-badge";
import { errorMessage, formatDateTime } from "@/components/geo/tasks/labels";
import { putGeoCredentialFn, reencryptGeoCredentialsFn, removeGeoCredentialFn } from "@/server/geo/admin";
import { ResultNotice } from "./notice";
import { geoAdminKeys, useGeoCredentials } from "./queries";

/** The value field is write-only: it starts empty, is cleared after saving, and nothing ever fills it from the server. */
function CredentialDialog({
	organizationId,
	initialRef,
	onClose,
}: {
	organizationId: string;
	initialRef: string | null;
	onClose: () => void;
}) {
	const queryClient = useQueryClient();
	const [ref, setRef] = useState(initialRef ?? "");
	const [value, setValue] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function submit(e: React.FormEvent) {
		e.preventDefault();
		setBusy(true);
		setError(null);
		try {
			await putGeoCredentialFn({ data: { organizationId, input: { ref: ref.trim(), value } } });
			setValue("");
			await queryClient.invalidateQueries({ queryKey: geoAdminKeys.credentials(organizationId) });
			onClose();
		} catch (err) {
			setError(errorMessage(err));
		} finally {
			setBusy(false);
		}
	}

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>{initialRef ? `轮换 ${initialRef}` : "添加密钥"}</DialogTitle>
					<DialogDescription>
						密钥加密保存，保存后不会再显示。轮换后约 1 分钟内所有进程使用新值，请在供应商处确认新值可用后再作废旧值。
					</DialogDescription>
				</DialogHeader>
				<form onSubmit={submit} className="space-y-4">
					<div className="space-y-2">
						<Label htmlFor="credential-ref">引用名</Label>
						<Input
							id="credential-ref"
							value={ref}
							onChange={(e) => setRef(e.target.value.toUpperCase())}
							disabled={Boolean(initialRef)}
							placeholder="例如 DOUBAO_API_KEY"
							required
						/>
					</div>
					<div className="space-y-2">
						<Label htmlFor="credential-value">密钥值</Label>
						<Input
							id="credential-value"
							type="password"
							autoComplete="new-password"
							value={value}
							onChange={(e) => setValue(e.target.value)}
							required
						/>
					</div>
					<ResultNotice error={error} />
					<DialogFooter>
						<Button type="button" variant="outline" onClick={onClose}>
							取消
						</Button>
						<Button type="submit" disabled={busy || !ref.trim() || !value}>
							保存
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

export function GeoCredentialsTab({ organizationId }: { organizationId: string }) {
	const queryClient = useQueryClient();
	const { data } = useGeoCredentials(organizationId);
	const [editing, setEditing] = useState<{ ref: string | null } | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [message, setMessage] = useState<string | null>(null);
	const stale = (data?.credentials ?? []).filter((credential) => credential.needsReencryption).length;

	async function run(action: () => Promise<string | null>) {
		setError(null);
		setMessage(null);
		try {
			setMessage(await action());
			await queryClient.invalidateQueries({ queryKey: geoAdminKeys.credentials(organizationId) });
		} catch (err) {
			setError(errorMessage(err));
		}
	}

	return (
		<Card>
			<CardHeader className="flex flex-row items-start justify-between gap-4">
				<div className="space-y-1.5">
					<CardTitle className="text-base">平台密钥</CardTitle>
					<CardDescription>
						采样目标通过引用名使用这些密钥。密钥用 ELMO_ENCRYPTION_KEY 加密保存在数据库中，只能写入和轮换，不能查看。
					</CardDescription>
				</div>
				<Button size="sm" onClick={() => setEditing({ ref: null })}>
					添加密钥
				</Button>
			</CardHeader>
			<CardContent className="space-y-3">
				{(data?.missingRefs.length ?? 0) > 0 && (
					<ResultNotice error={`以下引用名被采样目标使用但尚未配置：${data?.missingRefs.join("、")}`} />
				)}
				{stale > 0 && (
					<div className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-sm">
						<span>{stale} 个密钥仍由旧加密密钥保护。确认新密钥已生效后重新加密，再从环境变量中移除旧密钥。</span>
						<Button
							size="sm"
							variant="outline"
							onClick={() =>
								run(async () => {
									const result = await reencryptGeoCredentialsFn({ data: { organizationId } });
									return `已重新加密 ${result.reencrypted} 个，失败 ${result.failed} 个`;
								})
							}
						>
							用当前密钥重新加密
						</Button>
					</div>
				)}
				<ResultNotice error={error} success={message} />
				<div className="rounded-lg border">
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>引用名</TableHead>
								<TableHead>值</TableHead>
								<TableHead>使用的采样目标</TableHead>
								<TableHead>最近更新</TableHead>
								<TableHead>加密密钥</TableHead>
								<TableHead />
							</TableRow>
						</TableHeader>
						<TableBody>
							{(data?.credentials ?? []).length === 0 && (
								<TableRow>
									<TableCell colSpan={6} className="text-center text-sm text-muted-foreground">
										尚未配置密钥
									</TableCell>
								</TableRow>
							)}
							{(data?.credentials ?? []).map((credential) => (
								<TableRow key={credential.ref}>
									<TableCell className="font-mono">{credential.ref}</TableCell>
									<TableCell className="font-mono text-muted-foreground">••••••••</TableCell>
									<TableCell>
										{credential.usedBy.length === 0
											? "—"
											: credential.usedBy.map((platform) => GEO_PLATFORM_LABELS[platform] ?? platform).join("、")}
									</TableCell>
									<TableCell>{formatDateTime(credential.updatedAt)}</TableCell>
									<TableCell>
										<GeoStatusBadge
											label={credential.needsReencryption ? "旧密钥" : "当前密钥"}
											tone={credential.needsReencryption ? "warning" : "success"}
										/>
									</TableCell>
									<TableCell className="space-x-2 text-right">
										<Button size="sm" variant="outline" onClick={() => setEditing({ ref: credential.ref })}>
											轮换
										</Button>
										<Button
											size="sm"
											variant="outline"
											onClick={() => {
												if (!window.confirm(`删除 ${credential.ref}？使用它的采样目标将无法运行。`)) return;
												void run(async () => {
													await removeGeoCredentialFn({ data: { organizationId, ref: credential.ref } });
													return `已删除 ${credential.ref}`;
												});
											}}
										>
											删除
										</Button>
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</div>
			</CardContent>
			{editing && (
				<CredentialDialog organizationId={organizationId} initialRef={editing.ref} onClose={() => setEditing(null)} />
			)}
		</Card>
	);
}
