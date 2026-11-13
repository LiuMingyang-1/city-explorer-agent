/** 用户出行约束：date 必填，时间段缺省表示当天全天可用。 */
export interface PlanningConstraints {
  /** 出行日期 "YYYY-MM-DD"，相对日期按本次运行的当前日期解释。 */
  date: string;
  /** 当天可用开始时间 "HH:MM"。 */
  availableStart?: string;
  /** 当天可用结束时间 "HH:MM"。 */
  availableEnd?: string;
}

/**
 * 行程中的一站。字段名与最终输出 JSON 完全一致（snake_case，
 * 结构见 docs/architecture/overview.md 的最终 stdout 契约一节），解析时无需改名。
 */
export interface ItineraryStop {
  event_id: string;
  arrive_at: string; // "HH:MM"
  leave_at: string; // "HH:MM"
  reason: string;
}

/** Agent 输出的完整行程；每次修改都返回新的完整对象。 */
export interface Itinerary {
  date: string; // "YYYY-MM-DD"
  summary: string;
  stops: ItineraryStop[];
}
