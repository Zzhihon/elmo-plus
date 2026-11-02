import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Alert, AlertDescription } from "@workspace/ui/components/alert";
import { Button } from "@workspace/ui/components/button";
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
import { Textarea } from "@workspace/ui/components/textarea";
import { useState } from "react";
import { errorMessage, siteQueryKeys } from "@/components/geo/site-pages/site-labels";
import { createSiteFn, updateSiteFn } from "@/server/geo/site";
import type { SiteSourceView } from "@/server/geo/site-core";

const DEFAULT_PROFILE = {
	id: "site",
	version: 1,
	scope: { include: [], exclude: [], maxDepth: 6, followLinks: true },
	volatile: { selectors: [], patterns: [] },
	categories: [],
};

interface FormState {
	baseUrl: string;
	allowedHosts: string;
	seedUrls: string;
	requestsPerSecond: string;
	maxPages: string;
	maxAssetMb: string;
	crawlCron: string;
	windowStart: string;
	windowEnd: string;
	windowTimezone: string;
	userAgentContact: string;
	authorizationNote: string;
	profile: string;
}

function initialState(source: SiteSourceView | null): FormState {
	return {
		baseUrl: source?.baseUrl ?? "",
		allowedHosts: source?.allowedHosts.join("\n") ?? "",
		seedUrls: source?.seedUrls.join("\n") ?? "",
		requestsPerSecond: String(source?.requestsPerSecond ?? 1),
		maxPages: String(source?.maxPages ?? 500),
		maxAssetMb: String(Math.round((source?.maxAssetBytes ?? 20 * 1024 * 1024) / 1024 / 1024)),
		crawlCron: source?.crawlCron ?? "",
		windowStart: source?.opWindow?.start ?? "",
		windowEnd: source?.opWindow?.end ?? "",
		windowTimezone: source?.opWindow?.timezone ?? "Asia/Shanghai",
		userAgentContact: source?.userAgentContact ?? "",
		authorizationNote: source?.authorizationNote ?? "",
		profile: JSON.stringify(source?.profile ?? DEFAULT_PROFILE, null, 2),
	};
}

function lines(value: string): string[] {
	return value
		.split(/[\n,，]/)
		.map((line) => line.trim())
		.filter(Boolean);
}

export function SiteSourceDialog({
	organizationId,
	source,
	open,
	onOpenChange,
}: {
	organizationId: string;
	source: SiteSourceView | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const queryClient = useQueryClient();
	const [form, setForm] = useState<FormState>(() => initialState(source));
	const [formError, setFormError] = useState<string | null>(null);
	const set = (key: keyof FormState) => (event: { target: { value: string } }) =>
		setForm((current) => ({ ...current, [key]: event.target.value }));

	const save = useMutation({
		mutationFn: async () => {
			let profile: unknown;
			try {
				profile = JSON.parse(form.profile);
			} catch {
				throw new Error("解析配置不是合法的 JSON");
			}
			const config = {
				baseUrl: form.baseUrl.trim(),
				allowedHosts: lines(form.allowedHosts),
				seedUrls: lines(form.seedUrls),
				requestsPerSecond: Number(form.requestsPerSecond),
				maxPages: Number(form.maxPages),
				maxAssetBytes: Math.round(Number(form.maxAssetMb) * 1024 * 1024),
				crawlCron: form.crawlCron.trim() || null,
				opWindow:
					form.windowStart && form.windowEnd
						? { start: form.windowStart, end: form.windowEnd, timezone: form.windowTimezone || "Asia/Shanghai" }
						: null,
				userAgentContact: form.userAgentContact.trim() || null,
				authorizationNote: form.authorizationNote.trim() || null,
				profile,
			};
			if (source) {
				return updateSiteFn({ data: { organizationId, siteId: source.id, patch: config } });
			}
			return createSiteFn({ data: { organizationId, config } });
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: siteQueryKeys.all });
			onOpenChange(false);
		},
		onError: (error) => setFormError(errorMessage(error)),
	});

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
				<DialogHeader>
					<DialogTitle>{source ? "编辑站点配置" : "登记授权站点"}</DialogTitle>
					<DialogDescription>
						只采集授权域名下的公开页面。所有网址都必须在授权域名内，越界网址会被拒绝并记入审计日志。
					</DialogDescription>
				</DialogHeader>
				<form
					className="grid gap-4"
					onSubmit={(event) => {
						event.preventDefault();
						setFormError(null);
						save.mutate();
					}}
				>
					<div className="grid gap-2">
						<Label htmlFor="site-base-url">站点首页</Label>
						<Input id="site-base-url" value={form.baseUrl} onChange={set("baseUrl")} placeholder="http://www.example.com/" required />
					</div>
					<div className="grid gap-4 sm:grid-cols-2">
						<div className="grid gap-2">
							<Label htmlFor="site-hosts">授权域名（每行一个）</Label>
							<Textarea id="site-hosts" rows={3} value={form.allowedHosts} onChange={set("allowedHosts")} />
						</div>
						<div className="grid gap-2">
							<Label htmlFor="site-seeds">栏目入口网址（每行一个）</Label>
							<Textarea id="site-seeds" rows={3} value={form.seedUrls} onChange={set("seedUrls")} />
						</div>
					</div>
					<div className="grid gap-4 sm:grid-cols-3">
						<div className="grid gap-2">
							<Label htmlFor="site-rps">每秒请求数（上限 2）</Label>
							<Input id="site-rps" type="number" step="0.1" min="0.1" max="2" value={form.requestsPerSecond} onChange={set("requestsPerSecond")} />
						</div>
						<div className="grid gap-2">
							<Label htmlFor="site-pages">单次页面预算</Label>
							<Input id="site-pages" type="number" min="1" value={form.maxPages} onChange={set("maxPages")} />
						</div>
						<div className="grid gap-2">
							<Label htmlFor="site-asset">附件大小上限（MB）</Label>
							<Input id="site-asset" type="number" min="1" value={form.maxAssetMb} onChange={set("maxAssetMb")} />
						</div>
					</div>
					<div className="grid gap-4 sm:grid-cols-4">
						<div className="grid gap-2 sm:col-span-1">
							<Label htmlFor="site-cron">增量定时（cron）</Label>
							<Input id="site-cron" value={form.crawlCron} onChange={set("crawlCron")} placeholder="0 3 * * *" />
						</div>
						<div className="grid gap-2">
							<Label htmlFor="site-window-start">运营时窗开始</Label>
							<Input id="site-window-start" type="time" value={form.windowStart} onChange={set("windowStart")} />
						</div>
						<div className="grid gap-2">
							<Label htmlFor="site-window-end">运营时窗结束</Label>
							<Input id="site-window-end" type="time" value={form.windowEnd} onChange={set("windowEnd")} />
						</div>
						<div className="grid gap-2">
							<Label htmlFor="site-window-tz">时区</Label>
							<Input id="site-window-tz" value={form.windowTimezone} onChange={set("windowTimezone")} />
						</div>
					</div>
					<div className="grid gap-4 sm:grid-cols-2">
						<div className="grid gap-2">
							<Label htmlFor="site-contact">User-Agent 联系方式</Label>
							<Input
								id="site-contact"
								value={form.userAgentContact}
								onChange={set("userAgentContact")}
								placeholder="项目联系页网址或项目邮箱"
							/>
						</div>
						<div className="grid gap-2">
							<Label htmlFor="site-auth">授权说明</Label>
							<Input id="site-auth" value={form.authorizationNote} onChange={set("authorizationNote")} />
						</div>
					</div>
					<div className="grid gap-2">
						<Label htmlFor="site-profile">解析配置（JSON，改动后须提升 version）</Label>
						<Textarea
							id="site-profile"
							rows={14}
							className="font-mono text-xs"
							value={form.profile}
							onChange={set("profile")}
						/>
					</div>
					{formError && (
						<Alert variant="destructive">
							<AlertDescription>{formError}</AlertDescription>
						</Alert>
					)}
					<DialogFooter>
						<Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
							取消
						</Button>
						<Button type="submit" disabled={save.isPending}>
							{save.isPending ? "保存中…" : "保存"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
