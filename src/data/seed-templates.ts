/**
 * 场地与活动模板：seed.ts 只负责按基准日展开与写库，数据集中在本文件。
 * 模板上的 extras（budget/note/guide/images）声明费用与素材字段，
 * 展开规则见 ./seed-extras.ts。
 */

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

/** 场地（名称、地址、坐标均为示意）。 */
export const VENUES = [
  ["西岸美术馆（模拟）", "徐汇区龙腾大道2600号（模拟地址）", 31.1895, 121.4702],
  ["余德耀美术馆（模拟）", "徐汇区丰谷路35号（模拟地址）", 31.1879, 121.4695],
  ["M50创意园展厅（模拟）", "普陀区莫干山路50号（模拟地址）", 31.2498, 121.435],
  ["刘海粟美术馆（模拟）", "长宁区延安西路1609号（模拟地址）", 31.2115, 121.4143],
  ["思南书局（模拟）", "黄浦区复兴中路517号（模拟地址）", 31.2135, 121.4682],
  ["钟书阁徐汇店（模拟）", "徐汇区龙华中路759号（模拟地址）", 31.1856, 121.4675],
  ["建投书局（模拟）", "虹口区公平路18号（模拟地址）", 31.2473, 121.5058],
  ["上生新所广场（模拟）", "长宁区延安西路1262号（模拟地址）", 31.2102, 121.4245],
  ["静安雕塑公园广场（模拟）", "静安区石门二路128号（模拟地址）", 31.236, 121.4555],
  ["美琪大戏院（模拟）", "静安区江宁路66号（模拟地址）", 31.233, 121.4595],
  ["上海音乐厅（模拟）", "黄浦区延安东路523号（模拟地址）", 31.227, 121.4723],
  ["MAO Livehouse（模拟）", "黄浦区重庆南路308号（模拟地址）", 31.212, 121.469],
  ["复星艺术中心（模拟）", "黄浦区中山东二路600号（模拟地址）", 31.2289, 121.4923],
  ["龙美术馆西岸馆（模拟）", "徐汇区龙腾大道3398号（模拟地址）", 31.1758, 121.469],
  ["衡山和集书店（模拟）", "徐汇区衡山路880号（模拟地址）", 31.202, 121.446],
  ["苏州河步道广场（模拟）", "普陀区光复西路1143号（模拟地址）", 31.245, 121.427],
] as const;

/** "free" = 免费（budgetMin/Max 为 0）；{min,max} = 每人费用区间（分）；省略 = 未知（null）。 */
export type BudgetSpec = "free" | { min: number; max: number };

/** 费用与素材规格；全部可选，省略即对应字段为 null / 空数组。 */
export interface ExtrasSpec {
  budget?: BudgetSpec;
  /** 费用补充说明（票价档位、押金、消费另计等）。 */
  note?: string;
  /** 是否生成攻略链接。 */
  guide?: boolean;
  /** 图片数量（0 表示无图，同时无缩略图）。 */
  images?: number;
}

export interface SeedTemplate extends ExtrasSpec {
  category: string;
  title: string;
  detail: string;
  venue: number;
  days: number[];
  open?: string;
  close?: string;
  at?: string;
  run?: number;
  suggested: number;
}

/** 时间窗活动：open–close 之间可自由参观，建议停留 suggested 分钟。 */
const win = (
  category: string, title: string, detail: string, venue: number,
  days: number[], open: string, close: string, suggested: number,
  extras: ExtrasSpec = {},
): SeedTemplate => ({ category, title, detail, venue, days, open, close, suggested, ...extras });

/** 固定场次活动：at 开始，持续 run 分钟，建议留满全程。 */
const sess = (
  category: string, title: string, detail: string, venue: number,
  days: number[], at: string, run: number,
  extras: ExtrasSpec = {},
): SeedTemplate => ({ category, title, detail, venue, days, at, run, suggested: run, ...extras });

/** 大部分活动有费用、攻略与多图；保留少量免费 0 图、无攻略与费用未知样例。 */
export const TEMPLATES: SeedTemplate[] = [
  win("展览", "「时间的形状」当代艺术群展", "汇集十二位艺术家的装置与影像作品", 0, ALL_DAYS, "10:00", "18:00", 90, { budget: { min: 12000, max: 15000 }, note: "学生票半价", images: 3, guide: true }),
  win("展览", "「江南织物考」明清织绣展", "展出苏绣、缂丝与妆花实物", 1, ALL_DAYS, "10:00", "17:30", 60, { budget: { min: 8000, max: 10000 }, images: 2, guide: true }),
  win("展览", "「城市褶皱」摄影展", "记录上海街角与里弄变迁", 2, ALL_DAYS, "10:30", "19:00", 60, { budget: "free", images: 2, guide: true }),
  win("展览", "「纸本之上」版画专题展", "木版、铜版与丝网作品并置", 3, ALL_DAYS, "09:30", "17:00", 45, { budget: { min: 5000, max: 8000 }, note: "学生凭证免费", images: 1, guide: true }),
  win("展览", "「光与器」玻璃艺术展", "窑制玻璃与光影空间装置", 12, [0, 1, 2, 3], "10:00", "20:00", 60, { budget: { min: 9000, max: 12000 }, images: 3, guide: true }),
  win("展览", "青年艺术家邀请展", "三十件新作首次公开展出", 13, [4, 5, 6], "11:00", "19:30", 75, { budget: "free", images: 1, guide: true }),
  win("市集", "周末手作市集", "陶艺、皮具与独立首饰摊位", 7, [5, 6], "11:00", "21:00", 90, { budget: "free", note: "入场免费，摊位消费另计", images: 2, guide: true }),
  win("市集", "旧物循环市集", "二手书、黑胶与复古杂货", 8, [6], "10:00", "18:00", 60, { budget: "free", images: 1 }),
  win("市集", "深夜食堂市集", "小吃摊与精酿快闪档口", 7, [4, 5], "17:00", "23:00", 60, { note: "按摊位消费", images: 1 }),
  win("市集", "独立出版市集", "小册子、画报与活版印刷体验", 15, [3], "12:00", "20:00", 90, { budget: "free", note: "体验项目另计", images: 2, guide: true }),
  win("市集", "植物与生活市集", "盆栽、花艺与园艺杂货", 8, [1, 2], "10:00", "18:00", 45, { budget: "free", images: 2, guide: true }),
  sess("书店活动", "《江边日记》新书分享会", "作者到场对谈并签售", 4, ALL_DAYS, "19:00", 90, { budget: "free", note: "购书自愿", images: 2, guide: true }),
  sess("书店活动", "夜读诗歌会", "读者轮流朗读自选诗篇", 5, ALL_DAYS, "20:00", 60, { budget: "free", images: 1 }),
  sess("书店活动", "译者对谈：如何把诗译成诗", "两位译者现场交流并答疑", 14, [1, 3, 5], "19:30", 90, { budget: { min: 2000, max: 3000 }, note: "含茶饮", images: 2, guide: true }),
  win("书店活动", "午后共读角", "阅读区自由入座，提供主题书单与茶饮", 4, ALL_DAYS, "13:00", "18:00", 60, { budget: "free", note: "茶饮另计", images: 0, guide: true }),
  win("书店活动", "店内主题书展", "每周更换主题的小型书展，可自由参观", 6, ALL_DAYS, "12:00", "17:30", 45, { budget: "free", images: 0, guide: true }),
  sess("书店活动", "下午茶签售与读者见面会", "驻店作者签售并回答读者提问", 14, [0, 2, 4, 6], "15:00", 60, { budget: { min: 4500, max: 4500 }, note: "含下午茶套餐", images: 2, guide: true }),
  sess("演出", "沉浸式话剧《雾中站台》", "观众随演员在剧场空间内移动", 9, ALL_DAYS, "19:30", 100, { budget: { min: 18000, max: 28000 }, note: "分档票价", images: 3, guide: true }),
  sess("演出", "爵士四重奏现场", "标准曲与原创曲目各半", 11, ALL_DAYS, "20:30", 90, { note: "低消入场，金额以现场为准", images: 2, guide: true }),
  sess("演出", "脱口秀开放麦", "十组演员每人八分钟", 9, [5, 6], "21:00", 90, { budget: { min: 8000, max: 12000 }, images: 2, guide: true }),
  sess("讲座", "城市史讲座：苏州河的桥", "从外白渡桥讲到昌化路桥", 10, ALL_DAYS, "14:00", 90, { budget: "free", note: "需预约", images: 1, guide: true }),
  sess("工作坊", "蓝染手作体验", "完成一条方巾的扎染", 2, ALL_DAYS, "15:00", 120, { budget: { min: 9800, max: 12800 }, note: "含材料费", images: 2, guide: true }),
  sess("放映", "艺术电影露天放映", "经典黑白片配现场钢琴伴奏", 15, ALL_DAYS, "19:00", 120, { budget: { min: 3000, max: 5000 }, images: 2, guide: true }),
  sess("音乐现场", "新声乐队拼盘夜", "三支本地乐队轮流登台", 11, [0, 2, 4, 6], "20:00", 150, { budget: { min: 10000, max: 15000 }, images: 2 }),
];
