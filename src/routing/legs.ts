/**
 * 行程相邻站间道路段（PlanLeg，线上契约 snake_case，见
 * docs/agent-impl-contracts.md §2）。由服务端在行程校验通过后计算，
 * 模型不输出 legs；任何失败单 leg 降级，绝不抛出、不阻塞规划响应。
 */
import type { Event } from "../data/types.ts";
import type { ItineraryStop } from "../itinerary/types.ts";
import { routingErrorCode } from "./amap.ts";
import { DEFAULT_TRANSIT_THRESHOLD_M, haversineMeters, pickTravelMode } from "./geo.ts";
import type { GeoPoint, LegGeometry, RouteComputer, TravelMode } from "./types.ts";

/** 写入每条 leg 的默认站间缓冲（秒）。 */
export const DEFAULT_LEG_BUFFER_SECONDS = 300;

/** 线上契约：行程相邻两站间的道路段（docs/agent-impl-contracts.md §2）。 */
export interface PlanLeg {
  from_event_id: string;
  to_event_id: string;
  mode: TravelMode;
  status: "ok" | "error" | "skipped";
  provider: "amap" | "none";
  duration_seconds: number | null;
  distance_meters: number | null;
  buffer_seconds: number;
  /** [lng,lat] GCJ-02 LineString；算路失败/跳过时为 null。 */
  geometry: LegGeometry | null;
  /** 机读失败原因：missing_event / routing_disabled / 高德错误码 / route_error。 */
  error_code: string | null;
}

export interface ComputePlanLegsOptions {
  /**
   * 算路器（高德客户端或测试桩）；缺省/undefined → 全部 leg 记
   * status "skipped"、error_code "routing_disabled"（未配置
   * EXPLORER_AMAP_KEY 的降级路径），仍返回完整长度数组。
   */
  router?: RouteComputer | null;
  /** mode 自动选择的直线距离阈值（米）；缺省 3000。 */
  transitThresholdM?: number;
  /** 写入每条 leg 的 buffer_seconds；缺省 300。 */
  bufferSeconds?: number;
}

function skippedLeg(
  from: ItineraryStop,
  to: ItineraryStop,
  mode: TravelMode,
  buffer: number,
  errorCode: string,
): PlanLeg {
  return {
    from_event_id: from.event_id,
    to_event_id: to.event_id,
    mode,
    status: "skipped",
    provider: "none",
    duration_seconds: null,
    distance_meters: null,
    buffer_seconds: buffer,
    geometry: null,
    error_code: errorCode,
  };
}

function pointOf(event: Event): GeoPoint {
  return { lat: event.latitude, lng: event.longitude };
}

/**
 * 计算一个行程的全部相邻站 legs：stops.length-1 条，顺序与站序一致。
 *
 * 调用约定（接线方在 web/service.ts 响应装配处使用）：
 * - stops 为**已通过校验**的行程 stops（顺序即游览顺序）；
 * - eventsById 为 repository.getByIds(stops 全部 event_id) 的结果；
 *   缺库事件对应的 leg 记 skipped + error_code "missing_event"；
 * - 返回 Promise<PlanLeg[]>，单 leg 失败只降级该 leg，**绝不 reject**；
 * - 同 plan 内 legs 并行算路，总耗时 ≈ 最慢一条（单 leg 内部 ≤8s 超时）。
 */
export async function computePlanLegs(
  stops: ItineraryStop[],
  eventsById: ReadonlyMap<string, Event>,
  options: ComputePlanLegsOptions = {},
): Promise<PlanLeg[]> {
  const threshold = options.transitThresholdM ?? DEFAULT_TRANSIT_THRESHOLD_M;
  const buffer = options.bufferSeconds ?? DEFAULT_LEG_BUFFER_SECONDS;
  const router = options.router ?? null;

  const legs = stops.slice(0, -1).map(async (from, i) => {
    const to = stops[i + 1];
    const fromEvent = eventsById.get(from.event_id);
    const toEvent = eventsById.get(to.event_id);
    const mode =
      fromEvent && toEvent
        ? pickTravelMode(haversineMeters(pointOf(fromEvent), pointOf(toEvent)), threshold)
        : "walking"; // 缺坐标时的占位值；该 leg 不会真正算路。
    if (!fromEvent || !toEvent) {
      return skippedLeg(from, to, mode, buffer, "missing_event");
    }
    if (!router) {
      return skippedLeg(from, to, mode, buffer, "routing_disabled");
    }
    try {
      const routed = await router.route(
        { origin: pointOf(fromEvent), destination: pointOf(toEvent), mode },
        undefined,
      );
      return {
        from_event_id: from.event_id,
        to_event_id: to.event_id,
        mode,
        status: "ok" as const,
        provider: "amap" as const,
        duration_seconds: routed.durationSeconds,
        distance_meters: routed.distanceMeters,
        buffer_seconds: buffer,
        geometry: routed.geometry,
        error_code: null,
      };
    } catch (error) {
      return {
        from_event_id: from.event_id,
        to_event_id: to.event_id,
        mode,
        status: "error" as const,
        provider: "none" as const,
        duration_seconds: null,
        distance_meters: null,
        buffer_seconds: buffer,
        geometry: null,
        error_code: routingErrorCode(error),
      };
    }
  });
  return Promise.all(legs);
}
