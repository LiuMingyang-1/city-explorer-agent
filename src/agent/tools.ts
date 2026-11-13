import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { JsonValue } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { EventRepository } from "../data/repository.ts";

/** 工具名；参数 schema 对应 SearchEventsInput（date/category/keyword/near/radiusKm 均可选）。 */
export const SEARCH_EVENTS_TOOL = "search_events";

const searchEventsParameters = Type.Object({
  recordType: Type.Optional(Type.Union([Type.Literal("activity"), Type.Literal("attraction")], { description: "activity活动，attraction景点；可不传同时查询" })),
  date: Type.Optional(
    Type.String({ description: '出行日期 "YYYY-MM-DD"；只返回当天可参加的活动。' }),
  ),
  category: Type.Optional(
    Type.String({
      description: "活动类型如展览/市集/演出；recordType=attraction时为景点等级，如5A/4A/暂无评级。",
    }),
  ),
  keyword: Type.Optional(
    Type.String({ description: "关键词，匹配活动名称与介绍。" }),
  ),
  near: Type.Optional(
    Type.Object(
      {
        lat: Type.Number({ description: "参考点纬度。" }),
        lng: Type.Number({ description: "参考点经度。" }),
      },
      { description: "高德GCJ-02参考点经纬度；传入后按与该点的球面距离检索。" },
    ),
  ),
  radiusKm: Type.Optional(
    Type.Number({ description: "搜索半径（公里），需配合 near 使用；单独传入会被忽略。" }),
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
      "查询活动与景点共用数据库，坐标为高德GCJ-02。按 date / category / keyword 筛选，可多次调用（例如先查展览再查书店活动）。" +
      "返回活动或景点，recordType区分类型，category为活动分类或景点A级等级。availableWindows为当天多个可参加窗口，不得跨午休安排；startAt/endAt仅单窗口兼容字段。还含id、title、venueName、suggestedDurationMinutes，" +
      "以及费用与素材字段：budgetMin/budgetMax 为每人预计费用区间（单位分，100 分 = 1 元；0 是免费，null 是未知而非免费）、currency、budgetNote、" +
      "guideUrl/thumbnailUrl/imageUrls。" +
      "支持 near/radiusKm 按距离检索：传 near 时结果按距离升序，且每条含 distanceKm（公里）。",
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
