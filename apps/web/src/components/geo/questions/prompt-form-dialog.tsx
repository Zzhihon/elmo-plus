import {
	GEO_PRIORITIES,
	GEO_PROMPT_TIER_LABELS,
	GEO_PROMPT_TIERS,
	type GeoPriority,
	type GeoPromptTier,
} from "@workspace/geo-domain";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@workspace/ui/components/select";
import { Spinner } from "@workspace/ui/components/spinner";
import { Textarea } from "@workspace/ui/components/textarea";
import { type FormEvent, type ReactNode, useState } from "react";
import type { GeoBuyerRole, GeoMemberOption, GeoPromptRow } from "@/server/geo/prompts-core";

export interface PromptFormValues {
	question: string;
	buyerRoleId: string;
	intent: string;
	productLine: string;
	geoRegion: string;
	priority: GeoPriority;
	language: string;
	tier: GeoPromptTier;
	ownerId: string;
	sourceNote: string;
}

const NONE = "__none__";

function Field({ id, label, children }: { id: string; label: string; children: ReactNode }) {
	return (
		<div className="flex flex-col gap-1.5">
			<Label htmlFor={id}>{label}</Label>
			{children}
		</div>
	);
}

export function PromptFormDialog({
	prompt,
	roles,
	members,
	pending,
	error,
	onOpenChange,
	onSubmit,
}: {
	prompt: GeoPromptRow | null;
	roles: GeoBuyerRole[];
	members: GeoMemberOption[];
	pending: boolean;
	error: string | null;
	onOpenChange: (open: boolean) => void;
	onSubmit: (values: PromptFormValues) => void;
}) {
	const [values, setValues] = useState<PromptFormValues>({
		question: prompt?.question ?? "",
		buyerRoleId: prompt?.buyerRoleId ?? NONE,
		intent: prompt?.intent ?? "",
		productLine: prompt?.productLine ?? "",
		geoRegion: prompt?.geoRegion ?? "",
		priority: prompt?.priority ?? "P2",
		language: prompt?.language ?? "zh-CN",
		tier: prompt?.tier ?? "CORE",
		ownerId: prompt?.ownerId ?? NONE,
		sourceNote: prompt?.sourceNote ?? "",
	});
	const set = <K extends keyof PromptFormValues>(key: K, value: PromptFormValues[K]) =>
		setValues((current) => ({ ...current, [key]: value }));

	const roleItems = { [NONE]: "未指定", ...Object.fromEntries(roles.map((role) => [role.id, role.title])) };
	const memberItems = {
		[NONE]: "默认（创建人）",
		...Object.fromEntries(members.map((member) => [member.userId, member.name || member.email])),
	};

	const submit = (event: FormEvent) => {
		event.preventDefault();
		onSubmit(values);
	};

	return (
		<Dialog open onOpenChange={onOpenChange}>
			<DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
				<form onSubmit={submit} className="flex flex-col gap-4">
					<DialogHeader>
						<DialogTitle>{prompt ? "编辑问法" : "新建问法"}</DialogTitle>
						<DialogDescription>
							每次保存都生成一个修订版本。提交业务审核前需填写买方角色、意图、产品线和地区。
						</DialogDescription>
					</DialogHeader>
					<Field id="prompt-question" label="问法">
						<Textarea
							id="prompt-question"
							required
							rows={3}
							maxLength={500}
							value={values.question}
							onChange={(event) => set("question", event.target.value)}
						/>
					</Field>
					<div className="grid gap-4 sm:grid-cols-2">
						<Field id="prompt-role" label="买方角色">
							<Select
								items={roleItems}
								value={values.buyerRoleId}
								onValueChange={(value) => set("buyerRoleId", String(value ?? NONE))}
							>
								<SelectTrigger id="prompt-role">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value={NONE}>未指定</SelectItem>
									{roles.map((role) => (
										<SelectItem key={role.id} value={role.id}>
											{role.title}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</Field>
						<Field id="prompt-intent" label="意图">
							<Input
								id="prompt-intent"
								maxLength={200}
								placeholder="例如：供应商比较"
								value={values.intent}
								onChange={(event) => set("intent", event.target.value)}
							/>
						</Field>
						<Field id="prompt-product-line" label="产品线">
							<Input
								id="prompt-product-line"
								maxLength={200}
								placeholder="例如：高低压开关柜"
								value={values.productLine}
								onChange={(event) => set("productLine", event.target.value)}
							/>
						</Field>
						<Field id="prompt-region" label="地区">
							<Input
								id="prompt-region"
								maxLength={100}
								placeholder="例如：华南"
								value={values.geoRegion}
								onChange={(event) => set("geoRegion", event.target.value)}
							/>
						</Field>
						<Field id="prompt-priority" label="业务优先级">
							<Select
								items={Object.fromEntries(GEO_PRIORITIES.map((priority) => [priority, priority]))}
								value={values.priority}
								onValueChange={(value) => value && set("priority", value as GeoPriority)}
							>
								<SelectTrigger id="prompt-priority">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{GEO_PRIORITIES.map((priority) => (
										<SelectItem key={priority} value={priority}>
											{priority}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</Field>
						<Field id="prompt-tier" label="层级">
							<Select
								items={GEO_PROMPT_TIER_LABELS}
								value={values.tier}
								onValueChange={(value) => value && set("tier", value as GeoPromptTier)}
							>
								<SelectTrigger id="prompt-tier">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{GEO_PROMPT_TIERS.map((tier) => (
										<SelectItem key={tier} value={tier}>
											{GEO_PROMPT_TIER_LABELS[tier]}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</Field>
						<Field id="prompt-language" label="语言">
							<Input
								id="prompt-language"
								maxLength={20}
								value={values.language}
								onChange={(event) => set("language", event.target.value)}
							/>
						</Field>
						<Field id="prompt-owner" label="负责人">
							<Select
								items={memberItems}
								value={values.ownerId}
								onValueChange={(value) => set("ownerId", String(value ?? NONE))}
							>
								<SelectTrigger id="prompt-owner">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value={NONE}>默认（创建人）</SelectItem>
									{members.map((member) => (
										<SelectItem key={member.userId} value={member.userId}>
											{member.name || member.email}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</Field>
					</div>
					<Field id="prompt-source-note" label="来源说明">
						<Input
							id="prompt-source-note"
							maxLength={500}
							placeholder="例如：销售访谈整理"
							value={values.sourceNote}
							onChange={(event) => set("sourceNote", event.target.value)}
						/>
					</Field>
					{values.tier === "EXTENDED" && (
						<p className="text-sm text-muted-foreground">扩展问法会保存在问法库中，但默认不进入高频监测轮次。</p>
					)}
					{error && (
						<p className="text-sm text-destructive" role="alert">
							{error}
						</p>
					)}
					<DialogFooter>
						<Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
							取消
						</Button>
						<Button type="submit" disabled={pending || !values.question.trim()}>
							{pending && <Spinner />}
							保存
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

export function promptPayload(values: PromptFormValues) {
	return {
		question: values.question,
		buyerRoleId: values.buyerRoleId === NONE ? null : values.buyerRoleId,
		intent: values.intent || null,
		productLine: values.productLine || null,
		geoRegion: values.geoRegion || null,
		priority: values.priority,
		language: values.language || "zh-CN",
		tier: values.tier,
		ownerId: values.ownerId === NONE ? null : values.ownerId,
		sourceNote: values.sourceNote || null,
	};
}
