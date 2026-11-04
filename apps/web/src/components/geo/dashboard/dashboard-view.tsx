import { IconArrowDown, IconArrowUp, IconPlus, IconX } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Button, buttonVariants } from "@workspace/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@workspace/ui/components/card";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
	SheetTrigger,
} from "@workspace/ui/components/sheet";
import { Skeleton } from "@workspace/ui/components/skeleton";
import { cn } from "@workspace/ui/lib/utils";
import { type ReactNode, useState } from "react";
import { useGeoOrganization } from "@/components/geo/sampling/use-geo-organization";
import { GeoEmptyState } from "@/components/geo/shell/empty-state";
import { GeoPageFrame } from "@/components/geo/shell/page-frame";
import { useGeoViewer } from "@/components/geo/shell/use-geo-viewer";
import {
	getDashboardFn,
	getDashboardLayoutFn,
	resetDashboardLayoutFn,
	saveDashboardLayoutFn,
} from "@/server/geo/dashboard";
import type { DashboardData } from "@/server/geo/dashboard-core";
import {
	DASHBOARD_CARD_INFO,
	DASHBOARD_CARD_TYPES,
	type DashboardCard,
	type DashboardCardType,
	DEFAULT_DASHBOARD_LAYOUT,
	moveDashboardCard,
} from "@/server/geo/dashboard-layout";
import {
	CompetitorsCard,
	ConversationCard,
	ExposureCard,
	ImprovementsCard,
	RolesCard,
	SamplesCard,
	SiteCard,
	TrendCard,
} from "./cards";
import { dashboardKeys, errorText } from "./format";

const WIDE: ReadonlySet<DashboardCardType> = new Set(["exposure", "competitors", "roles"]);

function CardBody({ type, data }: { type: DashboardCardType; data: DashboardData | undefined }) {
	if (type === "improvements") return <ImprovementsCard />;
	if (type === "site") return <SiteCard />;
	if (!data) return <Skeleton className="h-40 w-full" />;
	switch (type) {
		case "exposure":
			return <ExposureCard data={data} />;
		case "competitors":
			return <CompetitorsCard data={data} />;
		case "trend":
			return <TrendCard data={data} />;
		case "roles":
			return <RolesCard data={data} />;
		case "conversation":
			return <ConversationCard data={data} />;
		case "samples":
			return <SamplesCard data={data} />;
	}
}

function DashboardTile({
	card,
	editing,
	first,
	last,
	onMove,
	onRemove,
	children,
}: {
	card: DashboardCard;
	editing: boolean;
	first: boolean;
	last: boolean;
	onMove: (offset: -1 | 1) => void;
	onRemove: () => void;
	children: ReactNode;
}) {
	const info = DASHBOARD_CARD_INFO[card.type];
	return (
		<Card className={cn(WIDE.has(card.type) && "lg:col-span-2", editing && "ring-2 ring-sky-200")}>
			<CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
				<div className="flex flex-col gap-1">
					<CardTitle className="text-base">{info.title}</CardTitle>
					{card.type !== "exposure" && <CardDescription>{info.description}</CardDescription>}
				</div>
				{editing && (
					<div className="flex shrink-0 items-center gap-1">
						<Button variant="ghost" size="icon" aria-label="上移" disabled={first} onClick={() => onMove(-1)}>
							<IconArrowUp className="size-4" />
						</Button>
						<Button variant="ghost" size="icon" aria-label="下移" disabled={last} onClick={() => onMove(1)}>
							<IconArrowDown className="size-4" />
						</Button>
						<Button variant="ghost" size="icon" aria-label="移除" onClick={onRemove}>
							<IconX className="size-4" />
						</Button>
					</div>
				)}
			</CardHeader>
			<CardContent>{children}</CardContent>
		</Card>
	);
}

function CardCatalog({ cards, onAdd }: { cards: DashboardCard[]; onAdd: (type: DashboardCardType) => void }) {
	const missing = DASHBOARD_CARD_TYPES.filter((type) => !cards.some((card) => card.type === type));
	return (
		<Sheet>
			<SheetTrigger render={<Button variant="outline" size="sm" />}>
				<IconPlus className="size-4" />
				添加卡片
			</SheetTrigger>
			<SheetContent className="flex flex-col gap-4">
				<SheetHeader>
					<SheetTitle>添加卡片</SheetTitle>
					<SheetDescription>选择要放到看板上的内容，新卡片会加在最后。</SheetDescription>
				</SheetHeader>
				<div className="flex flex-col gap-2 px-4">
					{missing.length === 0 ? (
						<p className="text-sm text-muted-foreground">所有卡片都已经在看板上了。</p>
					) : (
						missing.map((type) => (
							<div key={type} className="flex items-start justify-between gap-3 rounded-md border p-3">
								<div className="flex flex-col gap-0.5">
									<span className="text-sm font-medium">{DASHBOARD_CARD_INFO[type].title}</span>
									<span className="text-xs text-muted-foreground">{DASHBOARD_CARD_INFO[type].description}</span>
								</div>
								<Button size="sm" variant="secondary" onClick={() => onAdd(type)}>
									添加
								</Button>
							</div>
						))
					)}
				</div>
			</SheetContent>
		</Sheet>
	);
}

function EditActions({
	cards,
	editing,
	ready,
	saving,
	onEdit,
	onAdd,
	onReset,
	onCancel,
	onSave,
}: {
	cards: DashboardCard[];
	editing: boolean;
	ready: boolean;
	saving: boolean;
	onEdit: () => void;
	onAdd: (type: DashboardCardType) => void;
	onReset: () => void;
	onCancel: () => void;
	onSave: () => void;
}) {
	if (!editing) {
		return (
			<Button variant="outline" size="sm" disabled={!ready} onClick={onEdit}>
				编辑看板
			</Button>
		);
	}
	return (
		<>
			<CardCatalog cards={cards} onAdd={onAdd} />
			<Button variant="ghost" size="sm" disabled={saving} onClick={onReset}>
				恢复默认
			</Button>
			<Button variant="ghost" size="sm" onClick={onCancel}>
				取消
			</Button>
			<Button size="sm" disabled={saving} onClick={onSave}>
				保存
			</Button>
		</>
	);
}

function NoQuestionsYet() {
	const organization = useGeoOrganization();
	return (
		<GeoEmptyState
			title="还没有设定要监测的问题"
			description="先确定买家会问 AI 的一组问题和要对比的竞品，完成第一轮提问后，这里就会显示我们的曝光情况。"
			action={
				<Link
					to="/app/org/$org/geo/setup"
					params={{ org: organization.slug }}
					className={buttonVariants({ size: "sm" })}
				>
					设置监测问题与竞品
				</Link>
			}
		/>
	);
}

function DashboardGrid({
	cards,
	data,
	editing,
	canCustomize,
	onChange,
}: {
	cards: DashboardCard[];
	data: DashboardData | undefined;
	editing: boolean;
	canCustomize: boolean;
	onChange: (cards: DashboardCard[]) => void;
}) {
	if (data && !data.promptSet) return <NoQuestionsYet />;
	if (cards.length === 0) {
		return (
			<GeoEmptyState
				title="看板上没有卡片"
				description={canCustomize ? "点击“编辑看板”，从卡片库里添加想看的内容。" : "看板上暂时没有内容。"}
			/>
		);
	}
	return (
		<div className="grid gap-4 lg:grid-cols-2">
			{cards.map((card, index) => (
				<DashboardTile
					key={card.id}
					card={card}
					editing={editing}
					first={index === 0}
					last={index === cards.length - 1}
					onMove={(offset) => onChange(moveDashboardCard(cards, card.id, offset))}
					onRemove={() => onChange(cards.filter((entry) => entry.id !== card.id))}
				>
					<CardBody type={card.type} data={data} />
				</DashboardTile>
			))}
		</div>
	);
}

export function GeoDashboardView() {
	const organization = useGeoOrganization();
	const viewer = useGeoViewer();
	const queryClient = useQueryClient();
	const canCustomize = viewer.can("dashboard.customize");
	const [draft, setDraft] = useState<DashboardCard[] | null>(null);
	const [saveError, setSaveError] = useState<string | null>(null);
	const layout = useQuery({
		queryKey: dashboardKeys.layout(organization.id),
		queryFn: () => getDashboardLayoutFn({ data: { organizationId: organization.id } }),
	});
	const dashboard = useQuery({
		queryKey: dashboardKeys.data(organization.id),
		queryFn: () => getDashboardFn({ data: { organizationId: organization.id } }),
	});
	const onSaved = (result: { cards: DashboardCard[]; saved: boolean }) => {
		queryClient.setQueryData(dashboardKeys.layout(organization.id), result);
		setDraft(null);
		setSaveError(null);
	};
	const save = useMutation({
		mutationFn: (cards: DashboardCard[]) => saveDashboardLayoutFn({ data: { organizationId: organization.id, cards } }),
		onSuccess: onSaved,
		onError: (failure) => setSaveError(errorText(failure)),
	});
	const reset = useMutation({
		mutationFn: () => resetDashboardLayoutFn({ data: { organizationId: organization.id } }),
		onSuccess: onSaved,
		onError: (failure) => setSaveError(errorText(failure)),
	});

	const editing = draft !== null;
	const cards = draft ?? layout.data?.cards ?? (layout.error ? DEFAULT_DASHBOARD_LAYOUT : []);
	const actions = canCustomize ? (
		<EditActions
			cards={cards}
			editing={editing}
			ready={Boolean(layout.data)}
			saving={save.isPending || reset.isPending}
			onEdit={() => setDraft(layout.data?.cards ?? [])}
			onAdd={(type) => setDraft([...cards, { id: type, type }])}
			onReset={() => reset.mutate()}
			onCancel={() => setDraft(null)}
			onSave={() => save.mutate(cards)}
		/>
	) : undefined;

	return (
		<GeoPageFrame
			title="曝光看板"
			description="我们的品牌在主流 AI 回答里被看到、被推荐的情况，以及和竞品的对比。"
			actions={actions}
		>
			{saveError && <p className="text-sm text-destructive">{saveError}</p>}
			{layout.error && <p className="text-sm text-muted-foreground">没能读取你保存的看板布局，先按默认布局显示。</p>}
			{dashboard.error && <p className="text-sm text-destructive">{errorText(dashboard.error)}</p>}
			{!layout.data && !layout.error ? (
				<Skeleton className="h-96 w-full" />
			) : (
				<DashboardGrid
					cards={cards}
					data={dashboard.data}
					editing={editing}
					canCustomize={canCustomize}
					onChange={setDraft}
				/>
			)}
		</GeoPageFrame>
	);
}
