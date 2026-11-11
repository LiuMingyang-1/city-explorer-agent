import type { Event } from "../src/data/types.ts";
import type { PlanningConstraints } from "../src/itinerary/types.ts";

/** validation-*.test.ts 共用的构造器与默认约束；不是测试文件（无 .test 后缀）。 */

export const DAY = "2026-11-14";

export function makeEvent(overrides: Partial<Event> = {}): Event {
  return {
    id: "evt_001",
    title: "「时间的形状」当代艺术群展",
    description: "汇集十二位艺术家的装置与影像作品（模拟数据，非真实活动）",
    category: "展览",
    venueName: "西岸美术馆（模拟）",
    address: "徐汇区龙腾大道2600号（模拟地址）",
    latitude: 31.1895,
    longitude: 121.4702,
    startAt: `${DAY}T10:00`,
    endAt: `${DAY}T18:00`,
    suggestedDurationMinutes: 90,
    budgetMin: null,
    budgetMax: null,
    currency: "CNY",
    budgetNote: null,
    guideUrl: null,
    thumbnailUrl: null,
    imageUrls: [],
    ...overrides,
  };
}

export function makeStop(overrides: Record<string, unknown> = {}) {
  return {
    event_id: "evt_001",
    arrive_at: "13:00",
    leave_at: "14:30",
    reason: "展览主题符合兴趣",
    ...overrides,
  };
}

export function makeItinerary(overrides: Record<string, unknown> = {}) {
  return { date: DAY, summary: "下午看展", stops: [makeStop()], ...overrides };
}

export const NO_LIMITS: PlanningConstraints = { date: DAY };

export function eventsOf(...events: Event[]): Map<string, Event> {
  return new Map(events.map((e) => [e.id, e]));
}
