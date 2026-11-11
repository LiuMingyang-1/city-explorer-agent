import type { Event, SearchEventsInput } from "./types.ts";

/**
 * 活动存取接口。Agent 只通过该接口取活动，不直接编写 SQL。
 * 首版实现为 SQLite（见 ./sqlite.ts），行程数据只读。
 */
export interface EventRepository {
  /** 按日期、类型、关键词筛选活动；全部条件缺省时由实现方限制返回数量。 */
  search(input: SearchEventsInput): Promise<Event[]>;
  /** 按 ID 批量取活动，返回 id → Event；不存在的 id 不出现在结果中。 */
  getByIds(ids: string[]): Promise<Map<string, Event>>;
  /** 释放底层连接；进程内单例使用，CLI 退出前调用。 */
  close(): void;
}
