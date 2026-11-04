import { GEO_CITED_CONTENT_TYPES, type GeoCitedContentType } from "@workspace/geo-domain";
import { hostOf } from "@workspace/geo-evidence";
import { z } from "zod";

export const GEO_CITATION_RULES_CLASSIFIER = "rules-v1";

const MULTI_PART_SUFFIXES = new Set(["com.cn", "net.cn", "org.cn", "gov.cn", "edu.cn", "ac.cn", "com.hk", "co.uk"]);

/** The registrable part of a host ("zhuanlan.zhihu.com" → "zhihu.com"), so one platform reads as one channel. */
export function siteDomainOf(urlOrHost: string): string | null {
	const host = (urlOrHost.includes("/") || urlOrHost.includes(":") ? hostOf(urlOrHost) : urlOrHost)
		?.toLowerCase()
		.replace(/^www\./, "");
	if (!host) return null;
	if (/^\d+(\.\d+){3}$/.test(host)) return host;
	const labels = host.split(".");
	const keep = MULTI_PART_SUFFIXES.has(labels.slice(-2).join(".")) ? 3 : 2;
	return labels.slice(-keep).join(".");
}

export interface ThirdPartyPlatform {
	name: string;
	contentType: GeoCitedContentType;
}

/**
 * Hosts that are publishing platforms rather than anyone's own site. Matched on the full
 * host first (baike.baidu.com is not baijiahao.baidu.com), then on the registrable domain.
 */
const PLATFORMS: Record<string, ThirdPartyPlatform> = {
	"zhihu.com": { name: "知乎", contentType: "QA_COMMUNITY" },
	"zhidao.baidu.com": { name: "百度知道", contentType: "QA_COMMUNITY" },
	"tieba.baidu.com": { name: "百度贴吧", contentType: "QA_COMMUNITY" },
	"wenwen.sogou.com": { name: "搜狗问问", contentType: "QA_COMMUNITY" },
	"wenda.so.com": { name: "360 问答", contentType: "QA_COMMUNITY" },
	"iask.sina.com.cn": { name: "新浪爱问", contentType: "QA_COMMUNITY" },
	"wukong.com": { name: "悟空问答", contentType: "QA_COMMUNITY" },
	"douban.com": { name: "豆瓣", contentType: "QA_COMMUNITY" },
	"baike.baidu.com": { name: "百度百科", contentType: "COMPANY_PROFILE" },
	"baike.sogou.com": { name: "搜狗百科", contentType: "COMPANY_PROFILE" },
	"baike.so.com": { name: "360 百科", contentType: "COMPANY_PROFILE" },
	"baike.com": { name: "快懂百科", contentType: "COMPANY_PROFILE" },
	"wikipedia.org": { name: "维基百科", contentType: "COMPANY_PROFILE" },
	"baijiahao.baidu.com": { name: "百家号", contentType: "MEDIA_ARTICLE" },
	"mbd.baidu.com": { name: "百家号", contentType: "MEDIA_ARTICLE" },
	"mp.weixin.qq.com": { name: "微信公众号", contentType: "MEDIA_ARTICLE" },
	"new.qq.com": { name: "腾讯新闻", contentType: "MEDIA_ARTICLE" },
	"sohu.com": { name: "搜狐号", contentType: "MEDIA_ARTICLE" },
	"163.com": { name: "网易号", contentType: "MEDIA_ARTICLE" },
	"toutiao.com": { name: "今日头条", contentType: "MEDIA_ARTICLE" },
	"sina.com.cn": { name: "新浪", contentType: "MEDIA_ARTICLE" },
	"sina.cn": { name: "新浪", contentType: "MEDIA_ARTICLE" },
	"ifeng.com": { name: "凤凰网", contentType: "MEDIA_ARTICLE" },
	"thepaper.cn": { name: "澎湃新闻", contentType: "MEDIA_ARTICLE" },
	"csdn.net": { name: "CSDN", contentType: "MEDIA_ARTICLE" },
	"jianshu.com": { name: "简书", contentType: "MEDIA_ARTICLE" },
	"bjx.com.cn": { name: "北极星电力网", contentType: "MEDIA_ARTICLE" },
	"cpnn.com.cn": { name: "中国电力新闻网", contentType: "MEDIA_ARTICLE" },
	"chinapower.com.cn": { name: "中国电力网", contentType: "MEDIA_ARTICLE" },
	"xinhuanet.com": { name: "新华网", contentType: "MEDIA_ARTICLE" },
	"people.com.cn": { name: "人民网", contentType: "MEDIA_ARTICLE" },
	"1688.com": { name: "1688", contentType: "DIRECTORY_LISTING" },
	"alibaba.com": { name: "阿里巴巴国际站", contentType: "DIRECTORY_LISTING" },
	"hc360.com": { name: "慧聪网", contentType: "DIRECTORY_LISTING" },
	"made-in-china.com": { name: "中国制造网", contentType: "DIRECTORY_LISTING" },
	"gongchang.com": { name: "世界工厂网", contentType: "DIRECTORY_LISTING" },
	"china.cn": { name: "中国供应商", contentType: "DIRECTORY_LISTING" },
	"huangye88.com": { name: "黄页88", contentType: "DIRECTORY_LISTING" },
	"11467.com": { name: "顺企网", contentType: "DIRECTORY_LISTING" },
	"jdzj.com": { name: "机电之家", contentType: "DIRECTORY_LISTING" },
	"qcc.com": { name: "企查查", contentType: "DIRECTORY_LISTING" },
	"qichacha.com": { name: "企查查", contentType: "DIRECTORY_LISTING" },
	"tianyancha.com": { name: "天眼查", contentType: "DIRECTORY_LISTING" },
	"aiqicha.baidu.com": { name: "爱企查", contentType: "DIRECTORY_LISTING" },
	"b2b.baidu.com": { name: "百度爱采购", contentType: "DIRECTORY_LISTING" },
};

export function thirdPartyPlatformOf(url: string): (ThirdPartyPlatform & { domain: string }) | null {
	const host = hostOf(url)
		?.toLowerCase()
		.replace(/^www\./, "");
	if (!host) return null;
	const domain = siteDomainOf(host);
	const byHost = PLATFORMS[host];
	if (byHost) return { ...byHost, domain: host };
	if (domain && PLATFORMS[domain]) return { ...(PLATFORMS[domain] as ThirdPartyPlatform), domain };
	return null;
}

const PATH_RULES: [RegExp, GeoCitedContentType][] = [
	[/\/(case|cases|anli|gcal|project|projects|yeji|success)(\/|[-_.]|$)/i, "CASE_STUDY"],
	[
		/\/(honor|honors|rongyu|zizhi|certificate|certificates|qualification|qualifications|zhengshu)(\/|[-_.]|$)/i,
		"QUALIFICATION",
	],
	[/\/(product|products|chanpin|cpzx|cp|goods|item)(\/|[-_.]|$)/i, "PRODUCT_SPEC"],
	[/\/(faq|xuanxing|selection|guide)(\/|[-_.]|$)/i, "SELECTION_GUIDE"],
	[/\/(about|aboutus|about-us|guanyu|gywm|company|jianjie|intro|profile)(\/|[-_.]|$)/i, "COMPANY_PROFILE"],
	[/\/(news|xinwen|dongtai|xwzx|article|articles)(\/|[-_.]|$)/i, "NEWS"],
];

const TITLE_RULES: [RegExp, GeoCitedContentType][] = [
	[/产品手册|选型手册|技术参数|参数表|产品样本|规格书|说明书|datasheet/i, "PRODUCT_SPEC"],
	[/案例|业绩|工程项目|成功交付|中标/, "CASE_STUDY"],
	[/资质|证书|认证|荣誉|检测报告|型式试验/, "QUALIFICATION"],
	[/选型|怎么选|如何选择|选购指南|常见问题/, "SELECTION_GUIDE"],
	[/公司简介|关于我们|企业简介|公司介绍/, "COMPANY_PROFILE"],
];

/**
 * What a cited page is, from its address and title alone: known platforms by host, then
 * site sections by path, then unambiguous title words. Null means the rules cannot tell.
 */
export function classifyCitationByRules(url: string, title?: string | null): GeoCitedContentType | null {
	const platform = thirdPartyPlatformOf(url);
	if (platform) return platform.contentType;
	let path = "";
	try {
		path = decodeURIComponent(new URL(url).pathname);
	} catch {
		path = "";
	}
	for (const [pattern, type] of PATH_RULES) if (pattern.test(path)) return type;
	if (title) for (const [pattern, type] of TITLE_RULES) if (pattern.test(title)) return type;
	return null;
}

export const GEO_CITATION_CLASSIFY_BATCH = 40;

export function buildCitationClassificationPrompt(items: readonly { url: string; title: string | null }[]): string {
	return [
		"下面是 AI 回答中引用的网页，只给出网址和标题。请判断每个网页属于哪一类内容，只依据网址和标题，不要猜测网页正文。",
		"",
		"类别：",
		"- PRODUCT_SPEC：产品介绍、型号参数、产品手册",
		"- CASE_STUDY：工程案例、项目业绩",
		"- QUALIFICATION：资质证书、认证、检测报告、荣誉",
		"- COMPANY_PROFILE：公司简介、百科词条",
		"- NEWS：企业新闻、动态",
		"- SELECTION_GUIDE：选型指南、技术科普、常见问题",
		"- DIRECTORY_LISTING：B2B 平台、黄页、企业信息查询页",
		"- QA_COMMUNITY：问答社区、论坛帖子",
		"- MEDIA_ARTICLE：媒体或自媒体文章",
		"- OTHER：以上都不是或无法判断",
		"",
		...items.map((item, index) => `${index}. ${item.url}${item.title ? `  标题：${item.title}` : ""}`),
	].join("\n");
}

export const citationClassificationSchema = z.object({
	items: z.array(z.object({ index: z.number().int().min(0), contentType: z.enum(GEO_CITED_CONTENT_TYPES) })),
});
