import type { ExtrasSpec } from "./seed-templates.ts";
import type { Event } from "./types.ts";

/** Event 的费用与素材字段子集；seed 生成与旧库补齐共用同一套规则。 */
export type EventExtras = Pick<
  Event,
  | "budgetMin"
  | "budgetMax"
  | "currency"
  | "budgetNote"
  | "guideUrl"
  | "thumbnailUrl"
  | "imageUrls"
>;

const GUIDE = "https://example.com/guides";
const IMG = "https://example.com/img";

/**
 * 按 eventId 与 extras 规格生成费用/攻略/图片字段；同输入输出恒定。
 * imageUrls 按展示顺序编号 1..N；无图（images 为 0 或缺省）时缩略图同为 null。
 */
export function eventExtras(eventId: string, spec: ExtrasSpec = {}): EventExtras {
  const budget = spec.budget;
  const imageUrls = Array.from(
    { length: spec.images ?? 0 },
    (_, i) => `${IMG}/${eventId}/${i + 1}.jpg`,
  );
  return {
    budgetMin: budget === "free" ? 0 : (budget?.min ?? null),
    budgetMax: budget === "free" ? 0 : (budget?.max ?? null),
    currency: "CNY",
    budgetNote: spec.note ?? null,
    guideUrl: spec.guide ? `${GUIDE}/${eventId}` : null,
    thumbnailUrl: imageUrls.length > 0 ? `${IMG}/${eventId}/thumb.jpg` : null,
    imageUrls,
  };
}

/** 各类型默认每人费用区间（分）；未列出的类型走兜底区间。 */
const CATEGORY_BUDGET: Record<string, ExtrasSpec["budget"]> = {
  展览: { min: 8000, max: 12000 },
  演出: { min: 15000, max: 25000 },
  市集: "free",
  书店活动: "free",
  讲座: "free",
  工作坊: { min: 8000, max: 12800 },
  放映: { min: 3000, max: 5000 },
  音乐现场: { min: 10000, max: 15000 },
};

/**
 * 为既有活动（只有 id/category，无模板）确定性补齐新字段：
 * 费用按类别默认区间（id 序号每 13 条留 1 条费用未知样例），
 * 攻略链接齐全，图片按 id 轮转 1–3 张。
 */
export function defaultExtrasFor(eventId: string, category: string): EventExtras {
  const n = Number(/\d+/.exec(eventId)?.[0] ?? 0);
  const unknown = n > 0 && n % 13 === 0;
  return eventExtras(eventId, {
    budget: unknown ? undefined : (CATEGORY_BUDGET[category] ?? { min: 2000, max: 6000 }),
    note: unknown ? "费用以现场为准" : undefined,
    guide: true,
    images: (n % 3) + 1,
  });
}
