export const DASHBOARD_CARD_TYPES = [
	"exposure",
	"competitors",
	"trend",
	"roles",
	"conversation",
	"improvements",
	"site",
	"samples",
] as const;
export type DashboardCardType = (typeof DASHBOARD_CARD_TYPES)[number];

export interface DashboardCard {
	id: string;
	type: DashboardCardType;
}

export const DASHBOARD_CARD_INFO: Record<DashboardCardType, { title: string; description: string }> = {
	exposure: { title: "总曝光率", description: "各个 AI 平台回答里提到我们的比例，以及和上一个周期相比的变化。" },
	competitors: { title: "竞品对比排行", description: "我们和竞品在同一批回答里被提到、被推荐的情况。" },
	trend: { title: "曝光趋势", description: "每周曝光率的走势。" },
	roles: { title: "各采购角色曝光", description: "不同采购角色提问时，AI 是否会提到我们。" },
	conversation: { title: "最近一段典型对话", description: "最新一条 AI 回答的片段，标出我们和竞品。" },
	improvements: { title: "待改进 Top 3", description: "影响最大的三条提升建议。" },
	site: { title: "官网完善度", description: "官网还缺哪些内容、还有哪些问题没处理。" },
	samples: { title: "样本说明", description: "这些数字基于多少条回答、哪段时间、哪种获取方式。" },
};

export const DEFAULT_DASHBOARD_LAYOUT: DashboardCard[] = DASHBOARD_CARD_TYPES.map((type) => ({ id: type, type }));

function isCardType(value: unknown): value is DashboardCardType {
	return typeof value === "string" && (DASHBOARD_CARD_TYPES as readonly string[]).includes(value);
}

/**
 * A saved layout as it can be shown: cards whose type no longer exists are dropped and
 * each type appears once. Nothing saved means the default layout; a layout saved empty
 * stays empty, since that is what the person chose.
 */
export function normalizeDashboardLayout(
	cards: readonly { id?: unknown; type?: unknown }[] | null | undefined,
): DashboardCard[] {
	if (!cards) return DEFAULT_DASHBOARD_LAYOUT;
	const seen = new Set<DashboardCardType>();
	const result: DashboardCard[] = [];
	for (const card of cards) {
		if (!isCardType(card.type) || seen.has(card.type)) continue;
		seen.add(card.type);
		result.push({ id: card.type, type: card.type });
	}
	return result;
}

export function moveDashboardCard(cards: readonly DashboardCard[], id: string, offset: -1 | 1): DashboardCard[] {
	const index = cards.findIndex((card) => card.id === id);
	const target = index + offset;
	if (index < 0 || target < 0 || target >= cards.length) return [...cards];
	const next = [...cards];
	const [card] = next.splice(index, 1);
	if (card) next.splice(target, 0, card);
	return next;
}
