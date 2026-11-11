import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { JsonValue } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { EventRepository } from "../data/repository.ts";

/** 工具名；参数 schema 对应 SearchEventsInput（date/category/keyword 均可选）。 */
export const SEARCH_EVENTS_TOOL = "search_events";

const searchEventsParameters = Type.Object({
  date: Type.Optional(
    Type.String({ description: '出行日期 "YYYY-MM-DD"；只返回当天可参加的活动。' }),
  ),
  category: Type.Optional(
    Type.String({
      description: "活动类型，例如 展览 / 书店活动 / 市集 / 演出 / 讲座 / 工作坊 / 放映 / 音乐现场。",
    }),
  ),
  keyword: Type.Optional(
    Type.String({ description: "关键词，匹配活动名称与介绍。" }),
  ),
});

/**
 * 基于活动库构建 search_events 工具；Agent 经它查询活动，不直接写 SQL。
 * content 给模型读（活动 JSON，含 id/时间窗/建议时长），details 记命中数供日志。
 */
export function createSearchEventsTool(
  repository: EventRepository,
): AgentTool<typeof searchEventsParameters, { count: number }> {
  return {
    name: SEARCH_EVENTS_TOOL,
    label: "Search events",
    description:
      "查询活动数据库。按 date / category / keyword 筛选，可多次调用（例如先查展览再查书店活动）。" +
      "返回活动列表，每条含 id、title、category、venueName、startAt/endAt（可参加时间窗）、suggestedDurationMinutes，" +
      "以及费用与素材字段：budgetMin/budgetMax 为每人预计费用区间（单位分，100 分 = 1 元；0 是免费，null 是未知而非免费）、currency、budgetNote、" +
      "guideUrl/thumbnailUrl/imageUrls。",
    parameters: searchEventsParameters,
    execute: async (_toolCallId, params) => {
      const events = await repository.search(params);
      return {
        content: [{ type: "text", text: JSON.stringify(events) }],
        details: { count: events.length },
        structuredContent: { events } as unknown as JsonValue,
      };
    },
  };
}
