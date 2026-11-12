/**
 * estimate_travel 工具：让模型排期时核对相邻两站的真实通勤耗时与距离
 * （高德路径规划）。仅在配置了 EXPLORER_AMAP_KEY 时由装配层挂载；
 * 未挂载时模型按无算路处理（系统提示同步不含该工具说明）。
 */
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { JsonValue } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { EventRepository } from "../data/repository.ts";
import { routingErrorCode } from "../routing/amap.ts";
import { DEFAULT_TRANSIT_THRESHOLD_M, haversineMeters, pickTravelMode } from "../routing/geo.ts";
import type { RouteComputer, TravelMode } from "../routing/types.ts";

/** 工具名：estimate_travel。 */
export const ESTIMATE_TRAVEL_TOOL = "estimate_travel";

/** 工具结果载荷（content 为它的 JSON 序列化，details 同源）。 */
export interface EstimateTravelDetails {
  duration_seconds?: number;
  distance_meters?: number;
  mode?: TravelMode;
  error?: string;
  error_code?: string;
}

export interface EstimateTravelToolOptions {
  /** 算路器（高德客户端或测试桩）。 */
  router: RouteComputer;
  repository: EventRepository;
  /** mode 参数省略时的直线距离阈值（米）；缺省 3000。 */
  transitThresholdM?: number;
}

const estimateTravelParameters = Type.Object({
  from_event_id: Type.String({ description: "起点站活动 id（行程上前一站的 event_id）。" }),
  to_event_id: Type.String({ description: "终点站活动 id（行程上下一站的 event_id）。" }),
  mode: Type.Optional(
    Type.Union([Type.Literal("walking"), Type.Literal("transit")], {
      description:
        "出行方式；省略时按两站直线距离自动选择（默认 ≤3km 步行，否则公交）。",
    }),
  ),
});

function toResult(details: EstimateTravelDetails): AgentToolResult<EstimateTravelDetails> {
  return {
    content: [{ type: "text", text: JSON.stringify(details) }],
    details,
    structuredContent: details as unknown as JsonValue,
    isError: details.error !== undefined,
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 组装 estimate_travel 工具：from/to event_id → 查库取坐标 → 选 mode → 算路。
 * 成功返回 {duration_seconds, distance_meters, mode}（契约 §7）；
 * 活动 id 查无、mode 非法或算路失败一律 isError + 结构化 error_code，
 * 模型据此自行降级留缓冲，不中断排期。
 */
export function createEstimateTravelTool(
  options: EstimateTravelToolOptions,
): AgentTool<typeof estimateTravelParameters, EstimateTravelDetails> {
  const threshold = options.transitThresholdM ?? DEFAULT_TRANSIT_THRESHOLD_M;
  return {
    name: ESTIMATE_TRAVEL_TOOL,
    label: "Estimate travel",
    description:
      "估算两个活动站点间的真实通勤耗时与距离（高德路径规划）。" +
      "参数 from_event_id/to_event_id 为相邻两站的活动 id；mode 可省略（系统按直线距离自动选步行或公交）。" +
      "返回 {duration_seconds, distance_meters, mode}；排期时把通勤时间计入站间空隙。" +
      "活动 id 不存在或算路失败时返回错误，此时按经验留足缓冲即可。",
    parameters: estimateTravelParameters,
    execute: async (_toolCallId, params, signal) => {
      const fromId = typeof params.from_event_id === "string" ? params.from_event_id.trim() : "";
      const toId = typeof params.to_event_id === "string" ? params.to_event_id.trim() : "";
      if (!fromId || !toId) {
        return toResult({ error: "from_event_id 与 to_event_id 都不能为空" });
      }
      if (params.mode !== undefined && params.mode !== "walking" && params.mode !== "transit") {
        return toResult({ error: `mode 只支持 walking/transit，收到 ${String(params.mode)}` });
      }
      const events = await options.repository.getByIds([fromId, toId]);
      const from = events.get(fromId);
      const to = events.get(toId);
      if (!from || !to) {
        const missing = [!from && fromId, !to && toId].filter(Boolean).join(", ");
        return toResult({ error: `查无活动：${missing}`, error_code: "missing_event" });
      }
      const mode: TravelMode =
        params.mode ??
        pickTravelMode(
          haversineMeters(
            { lat: from.latitude, lng: from.longitude },
            { lat: to.latitude, lng: to.longitude },
          ),
          threshold,
        );
      try {
        const routed = await options.router.route(
          {
            origin: { lat: from.latitude, lng: from.longitude },
            destination: { lat: to.latitude, lng: to.longitude },
            mode,
          },
          signal,
        );
        return toResult({
          duration_seconds: routed.durationSeconds,
          distance_meters: routed.distanceMeters,
          mode,
        });
      } catch (error) {
        return toResult({
          error: `算路失败：${errorText(error)}`,
          error_code: routingErrorCode(error),
        });
      }
    },
  };
}
