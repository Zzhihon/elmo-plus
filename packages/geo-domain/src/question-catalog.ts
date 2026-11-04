import type { GEO_DEFAULT_BUYER_ROLES, GeoPriority, GeoPromptSetStatus, GeoPromptStatus, GeoPromptTier } from "./enums";
import { actorHolds, fail, type GeoTransitionActor, type GeoTransitionResult } from "./transition";

export type GeoCatalogBuyerRoleCode = (typeof GEO_DEFAULT_BUYER_ROLES)[number]["code"];

export interface GeoCatalogQuestion {
	code: string;
	question: string;
	buyerRoleCode: GeoCatalogBuyerRoleCode;
	intent: string;
	productLine: string;
	geoRegion: string;
	priority: GeoPriority;
	tier: GeoPromptTier;
	recommended: boolean;
}

/** The questions a customer may monitor and the ones used to find competitors live in separately versioned sets. */
export const GEO_CATALOG_SET_NAME = "客户监测问题";
export const GEO_DISCOVERY_SET_NAME = "竞品发现问题";

export const GEO_CATALOG_SELECTION_MIN = 10;
export const GEO_CATALOG_SELECTION_MAX = 20;

const SWITCHGEAR = "高低压成套设备";
const HV = "高压开关柜";
const LV = "低压配电柜";
const SOUTH_CHINA = "华南";
const GUANGZHOU = "广州";

type Row = Omit<GeoCatalogQuestion, "tier" | "recommended"> & { recommended?: boolean };

const monitored = (row: Row): GeoCatalogQuestion => ({ ...row, tier: "CORE", recommended: row.recommended ?? false });

/** Generic buyer phrasing only: a question that names a brand would bias what the answer engines mention. */
export const GEO_QUESTION_CATALOG: readonly GeoCatalogQuestion[] = [
	monitored({
		code: "OWNER_SUPPLIER_SHORTLIST",
		question: "广州有哪些靠谱的高低压成套配电设备厂家？",
		buyerRoleCode: "OWNER_PROJECT_MANAGER",
		intent: "供应商筛选",
		productLine: SWITCHGEAR,
		geoRegion: GUANGZHOU,
		priority: "P0",
		recommended: true,
	}),
	monitored({
		code: "OWNER_FACTORY_POWER",
		question: "新建工厂配电工程，华南地区选哪家开关柜供应商比较稳妥？",
		buyerRoleCode: "OWNER_PROJECT_MANAGER",
		intent: "供应商筛选",
		productLine: SWITCHGEAR,
		geoRegion: SOUTH_CHINA,
		priority: "P0",
		recommended: true,
	}),
	monitored({
		code: "OWNER_DELIVERY_TIME",
		question: "高低压开关柜从下单到交货一般要多久？怎么判断厂家能不能按期交付？",
		buyerRoleCode: "OWNER_PROJECT_MANAGER",
		intent: "交付能力",
		productLine: SWITCHGEAR,
		geoRegion: SOUTH_CHINA,
		priority: "P1",
	}),
	monitored({
		code: "OWNER_SUPPLIER_RISK",
		question: "选配电设备供应商时，怎样避免交付延期和售后跟不上的风险？",
		buyerRoleCode: "OWNER_PROJECT_MANAGER",
		intent: "风险规避",
		productLine: SWITCHGEAR,
		geoRegion: SOUTH_CHINA,
		priority: "P2",
	}),
	monitored({
		code: "OWNER_INDUSTRIAL_PARK",
		question: "产业园区配电房建设，广东有哪些有成功案例的成套设备厂家？",
		buyerRoleCode: "OWNER_PROJECT_MANAGER",
		intent: "案例参考",
		productLine: SWITCHGEAR,
		geoRegion: "广东",
		priority: "P1",
	}),

	monitored({
		code: "DESIGN_KYN28_MANUFACTURERS",
		question: "KYN28 金属铠装中置式开关柜，广东有哪些厂家做得比较好？",
		buyerRoleCode: "DESIGN_ELECTRICAL_ENGINEER",
		intent: "供应商筛选",
		productLine: HV,
		geoRegion: "广东",
		priority: "P0",
		recommended: true,
	}),
	monitored({
		code: "DESIGN_KYN28_VS_XGN",
		question: "10kV 配电项目选 KYN28 还是 XGN15 环网柜？各自适合什么场景？",
		buyerRoleCode: "DESIGN_ELECTRICAL_ENGINEER",
		intent: "方案选型",
		productLine: HV,
		geoRegion: SOUTH_CHINA,
		priority: "P1",
		recommended: true,
	}),
	monitored({
		code: "DESIGN_GCK_VS_MNS",
		question: "低压抽出式开关柜 GCK 和 MNS 怎么选？哪些厂家能做？",
		buyerRoleCode: "DESIGN_ELECTRICAL_ENGINEER",
		intent: "方案选型",
		productLine: LV,
		geoRegion: SOUTH_CHINA,
		priority: "P1",
	}),
	monitored({
		code: "DESIGN_TYPE_TEST",
		question: "高压开关柜的型式试验报告和 3C 认证应该怎么核查？",
		buyerRoleCode: "DESIGN_ELECTRICAL_ENGINEER",
		intent: "资质核查",
		productLine: HV,
		geoRegion: SOUTH_CHINA,
		priority: "P2",
	}),
	monitored({
		code: "DESIGN_HUMID_CLIMATE",
		question: "华南高温高湿环境下，开关柜在防凝露和散热方面要注意什么？推荐哪些厂家？",
		buyerRoleCode: "DESIGN_ELECTRICAL_ENGINEER",
		intent: "技术要求",
		productLine: SWITCHGEAR,
		geoRegion: SOUTH_CHINA,
		priority: "P2",
	}),

	monitored({
		code: "PROCUREMENT_GGD_SUPPLIERS",
		question: "广州 GGD 低压配电柜生产厂家有哪些？哪家性价比高？",
		buyerRoleCode: "PROCUREMENT_LEAD",
		intent: "供应商筛选",
		productLine: LV,
		geoRegion: GUANGZHOU,
		priority: "P0",
		recommended: true,
	}),
	monitored({
		code: "PROCUREMENT_QUALIFIED_LIST",
		question: "采购高压开关柜，供应商需要具备哪些资质？华南有哪些合格供应商？",
		buyerRoleCode: "PROCUREMENT_LEAD",
		intent: "资质核查",
		productLine: HV,
		geoRegion: SOUTH_CHINA,
		priority: "P1",
		recommended: true,
	}),
	monitored({
		code: "PROCUREMENT_TENDER_EVAL",
		question: "成套配电设备招标时，怎么评估投标厂家的实力？",
		buyerRoleCode: "PROCUREMENT_LEAD",
		intent: "评标方法",
		productLine: SWITCHGEAR,
		geoRegion: SOUTH_CHINA,
		priority: "P2",
	}),
	monitored({
		code: "PROCUREMENT_LOCAL_VS_NATIONAL",
		question: "买开关柜选广州本地厂家还是全国大品牌，各有什么优缺点？",
		buyerRoleCode: "PROCUREMENT_LEAD",
		intent: "供应商对比",
		productLine: SWITCHGEAR,
		geoRegion: GUANGZHOU,
		priority: "P1",
		recommended: true,
	}),
	monitored({
		code: "PROCUREMENT_FACTORY_AUDIT",
		question: "考察开关柜生产厂家时，应该重点看哪些地方？",
		buyerRoleCode: "PROCUREMENT_LEAD",
		intent: "供应商考察",
		productLine: SWITCHGEAR,
		geoRegion: SOUTH_CHINA,
		priority: "P3",
	}),

	monitored({
		code: "EPC_SWITCHGEAR_PARTNER",
		question: "总包项目需要配套高低压开关柜，华南有哪些配合度高、交货快的厂家？",
		buyerRoleCode: "EPC_ELECTRICAL_ENGINEER",
		intent: "供应商筛选",
		productLine: SWITCHGEAR,
		geoRegion: SOUTH_CHINA,
		priority: "P0",
		recommended: true,
	}),
	monitored({
		code: "EPC_BOX_SUBSTATION",
		question: "箱式变电站和配套高低压柜，广东哪些厂家能一起供货？",
		buyerRoleCode: "EPC_ELECTRICAL_ENGINEER",
		intent: "供应商筛选",
		productLine: "箱式变电站",
		geoRegion: "广东",
		priority: "P1",
	}),
	monitored({
		code: "EPC_SITE_COMMISSIONING",
		question: "开关柜到货后的安装调试，厂家一般提供哪些现场技术支持？",
		buyerRoleCode: "EPC_ELECTRICAL_ENGINEER",
		intent: "服务能力",
		productLine: SWITCHGEAR,
		geoRegion: SOUTH_CHINA,
		priority: "P2",
	}),
	monitored({
		code: "EPC_DATA_CENTER",
		question: "数据中心配电项目，低压开关柜选型要注意什么？有哪些厂家有经验？",
		buyerRoleCode: "EPC_ELECTRICAL_ENGINEER",
		intent: "案例参考",
		productLine: LV,
		geoRegion: SOUTH_CHINA,
		priority: "P1",
	}),
	monitored({
		code: "EPC_NONSTANDARD",
		question: "非标定制的配电柜，广州有哪些厂家能做深化设计？",
		buyerRoleCode: "EPC_ELECTRICAL_ENGINEER",
		intent: "定制能力",
		productLine: LV,
		geoRegion: GUANGZHOU,
		priority: "P2",
	}),

	monitored({
		code: "OPS_RETROFIT",
		question: "老旧配电房开关柜改造，广州有哪些厂家能做？",
		buyerRoleCode: "OPERATIONS_SUPERVISOR",
		intent: "改造升级",
		productLine: SWITCHGEAR,
		geoRegion: GUANGZHOU,
		priority: "P1",
		recommended: true,
	}),
	monitored({
		code: "OPS_AFTER_SALES",
		question: "开关柜售后服务哪家响应快？华南地区有本地服务网点的厂家有哪些？",
		buyerRoleCode: "OPERATIONS_SUPERVISOR",
		intent: "售后服务",
		productLine: SWITCHGEAR,
		geoRegion: SOUTH_CHINA,
		priority: "P1",
		recommended: true,
	}),
	monitored({
		code: "OPS_COMMON_FAULTS",
		question: "高压开关柜常见故障有哪些？哪些品牌的产品故障率比较低？",
		buyerRoleCode: "OPERATIONS_SUPERVISOR",
		intent: "质量口碑",
		productLine: HV,
		geoRegion: SOUTH_CHINA,
		priority: "P2",
	}),
	monitored({
		code: "OPS_SMART_MONITORING",
		question: "配电柜能加装在线监测和智能运维系统吗？有哪些厂家能提供？",
		buyerRoleCode: "OPERATIONS_SUPERVISOR",
		intent: "智能化",
		productLine: SWITCHGEAR,
		geoRegion: SOUTH_CHINA,
		priority: "P2",
	}),
	monitored({
		code: "OPS_SPARE_PARTS",
		question: "开关柜备品备件和断路器更换，找原厂还是第三方比较好？",
		buyerRoleCode: "OPERATIONS_SUPERVISOR",
		intent: "备件维保",
		productLine: SWITCHGEAR,
		geoRegion: SOUTH_CHINA,
		priority: "P3",
	}),

	monitored({
		code: "FINANCE_KYN28_PRICE",
		question: "一台 KYN28 高压开关柜大概多少钱？价格受哪些因素影响？",
		buyerRoleCode: "FINANCE_COST_LEAD",
		intent: "价格预算",
		productLine: HV,
		geoRegion: SOUTH_CHINA,
		priority: "P1",
		recommended: true,
	}),
	monitored({
		code: "FINANCE_GGD_PRICE",
		question: "GGD 低压配电柜价格一般在什么区间？怎么判断报价是否合理？",
		buyerRoleCode: "FINANCE_COST_LEAD",
		intent: "价格预算",
		productLine: LV,
		geoRegion: SOUTH_CHINA,
		priority: "P2",
	}),
	monitored({
		code: "FINANCE_LIFECYCLE_COST",
		question: "选配电设备时，怎样平衡采购价格和后期运维成本？",
		buyerRoleCode: "FINANCE_COST_LEAD",
		intent: "成本评估",
		productLine: SWITCHGEAR,
		geoRegion: SOUTH_CHINA,
		priority: "P2",
	}),
	monitored({
		code: "FINANCE_VALUE_SUPPLIERS",
		question: "广州有哪些性价比高的成套配电设备供应商？",
		buyerRoleCode: "FINANCE_COST_LEAD",
		intent: "供应商筛选",
		productLine: SWITCHGEAR,
		geoRegion: GUANGZHOU,
		priority: "P1",
		recommended: true,
	}),
	monitored({
		code: "FINANCE_PAYMENT_TERMS",
		question: "采购开关柜时，付款方式和质保金一般怎么约定？",
		buyerRoleCode: "FINANCE_COST_LEAD",
		intent: "商务条款",
		productLine: SWITCHGEAR,
		geoRegion: SOUTH_CHINA,
		priority: "P3",
	}),
];

const discovery = (row: Omit<Row, "recommended">): GeoCatalogQuestion => ({
	...row,
	tier: "EXTENDED",
	recommended: false,
});

/** Asked only to see which companies the answer engines name; kept out of routine monitoring. */
export const GEO_DISCOVERY_QUESTIONS: readonly GeoCatalogQuestion[] = [
	discovery({
		code: "DISCOVER_GZ_SWITCHGEAR",
		question: "广州有哪些高低压开关柜厂家？",
		buyerRoleCode: "PROCUREMENT_LEAD",
		intent: "竞品发现",
		productLine: SWITCHGEAR,
		geoRegion: GUANGZHOU,
		priority: "P2",
	}),
	discovery({
		code: "DISCOVER_SOUTH_CHINA_TOP",
		question: "华南地区知名的成套配电设备企业有哪些？",
		buyerRoleCode: "OWNER_PROJECT_MANAGER",
		intent: "竞品发现",
		productLine: SWITCHGEAR,
		geoRegion: SOUTH_CHINA,
		priority: "P2",
	}),
	discovery({
		code: "DISCOVER_GD_KYN28",
		question: "广东生产 KYN28 高压开关柜的企业有哪些？",
		buyerRoleCode: "DESIGN_ELECTRICAL_ENGINEER",
		intent: "竞品发现",
		productLine: HV,
		geoRegion: "广东",
		priority: "P2",
	}),
	discovery({
		code: "DISCOVER_GZ_LV_CABINET",
		question: "广州做 GGD、GCK 低压配电柜的厂家推荐几家",
		buyerRoleCode: "PROCUREMENT_LEAD",
		intent: "竞品发现",
		productLine: LV,
		geoRegion: GUANGZHOU,
		priority: "P2",
	}),
	discovery({
		code: "DISCOVER_GD_SUBSTATION",
		question: "广东箱式变电站和配电柜的主要生产厂家有哪些？",
		buyerRoleCode: "EPC_ELECTRICAL_ENGINEER",
		intent: "竞品发现",
		productLine: "箱式变电站",
		geoRegion: "广东",
		priority: "P2",
	}),
];

export function catalogSelectionProblem(count: number): string | null {
	if (count < GEO_CATALOG_SELECTION_MIN || count > GEO_CATALOG_SELECTION_MAX) {
		return `请选择 ${GEO_CATALOG_SELECTION_MIN}–${GEO_CATALOG_SELECTION_MAX} 个问题，当前已选 ${count} 个`;
	}
	return null;
}

/**
 * Picking a catalog question is its business review: the wording is ours, not the
 * picker's, so the no-self-review rule has nothing to guard. A question someone
 * already rejected stays rejected until it is revised through the question library.
 */
export function catalogAdoptionTransition(
	status: GeoPromptStatus,
	actor: GeoTransitionActor,
): GeoTransitionResult<GeoPromptStatus> {
	if (!actorHolds(actor, "prompt.select_catalog")) return fail("FORBIDDEN", "当前账号没有选择监测问题的权限");
	switch (status) {
		case "DRAFT":
		case "IN_REVIEW":
			return { ok: true, to: "BASELINE" };
		case "BASELINE":
		case "FROZEN":
			return { ok: true, to: status };
		case "REJECTED":
			return fail("CONFLICT", "该问题已被审核驳回，请联系运营人员处理");
	}
}

/** Freezing a set made only of adopted catalog questions; any other set still needs `prompt.freeze`. */
export function catalogSetFreezeTransition(
	status: GeoPromptSetStatus,
	actor: GeoTransitionActor,
	itemCount: number,
): GeoTransitionResult<GeoPromptSetStatus> {
	if (status !== "DRAFT") return fail("CONFLICT", "测试集已冻结，修改必须生成新版本");
	if (!actorHolds(actor, "prompt.select_catalog")) return fail("FORBIDDEN", "当前账号没有选择监测问题的权限");
	if (itemCount === 0) return fail("VALIDATION_ERROR", "不能冻结空的测试集");
	return { ok: true, to: "FROZEN" };
}

/** A prompt in a catalog set moves BASELINE → FROZEN under the same authority that adopted it. */
export function catalogPromptFreezeTransition(
	status: GeoPromptStatus,
	actor: GeoTransitionActor,
): GeoTransitionResult<GeoPromptStatus> {
	if (!actorHolds(actor, "prompt.select_catalog")) return fail("FORBIDDEN", "当前账号没有选择监测问题的权限");
	if (status === "BASELINE") return { ok: true, to: "FROZEN" };
	if (status === "FROZEN") return { ok: true, to: "FROZEN" };
	return fail("CONFLICT", `问法当前状态 ${status} 不能冻结`);
}
