/**
 * 一条活动时段记录，对应 SQLite events 表的一行（字段见 docs/database-design.md）。
 * TS 侧用 camelCase，数据库列名为 snake_case，由 repository 实现负责映射。
 */
export interface Event {
  id: string;
  title: string;
  description: string;
  category: string;
  venueName: string;
  address: string;
  latitude: number;
  longitude: number;
  /** 可参加开始时间，本地时间 "YYYY-MM-DDTHH:MM"（不带时区）。 */
  startAt: string;
  /** 可参加结束时间，格式同 startAt。 */
  endAt: string;
  suggestedDurationMinutes: number;
  /** 每人预计费用下限，单位分；null 表示未知，免费活动为 0。 */
  budgetMin: number | null;
  /** 每人预计费用上限，单位分；null 表示未知。 */
  budgetMax: number | null;
  /** 费用币种代码，默认 "CNY"。 */
  currency: string;
  /** 费用补充说明（如票价档位、押金），无则为 null。 */
  budgetNote: string | null;
  /** 相关攻略地址，无则为 null。 */
  guideUrl: string | null;
  /** 缩略图地址，无则为 null；只存 URL，不存图片本体。 */
  thumbnailUrl: string | null;
  /** 展示用图片地址列表，按展示顺序；只存 URL。 */
  imageUrls: string[];
}

/** search_events 工具参数与 EventRepository.search 共用的查询条件，均可选。 */
export interface SearchEventsInput {
  /** 出行日期 "YYYY-MM-DD"；匹配该日可参加的活动。 */
  date?: string;
  /** 活动类型，例如 展览 / 书店活动 / 市集 / 演出。 */
  category?: string;
  /** 关键词，匹配活动名称与介绍。 */
  keyword?: string;
}
